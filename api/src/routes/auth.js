'use strict';

const express   = require('express');
const router    = express.Router();
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const cassandra = require('cassandra-driver');
const { execute } = require('../cassandra/client');

const JWT_SECRET  = process.env.JWT_SECRET || 'supplychain_secret_2026';
const VALID_ROLES = ['MANUFACTURER', 'DISTRIBUTOR', 'RETAILER', 'CUSTOMER'];

// ─── Signup ───────────────────────────────────────────────────────────────
router.post('/signup', async (req, res) => {
  try {
    const {
      email, password, full_name, phone, cnic, profile_pic, role,
      company_name, registration_number, factory_address, city, country,
      product_categories, employee_count, website, company_logo, established_year,
      warehouse_address, coverage_areas, fleet_size, storage_capacity,
      store_name, license_number, store_address, store_type, store_size,
      store_logo, opening_hours,
      delivery_address, date_of_birth, gender
    } = req.body;

    if (!email || !password || !full_name || !role || !phone || !cnic) {
      return res.status(400).json({
        error: 'email, password, full_name, phone, cnic, role are required'
      });
    }

    const roleUpper = role.toUpperCase();
    if (!VALID_ROLES.includes(roleUpper)) {
      return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
    }

    const cnicRegex = /^\d{5}-\d{7}-\d{1}$/;
    if (!cnicRegex.test(cnic)) {
      return res.status(400).json({ error: 'CNIC must be in format: 00000-0000000-0' });
    }

    // Check email exists
    const emailCheck = await execute(
      'SELECT user_id FROM users WHERE email = ? ALLOW FILTERING',
      [email.toLowerCase()]
    );
    if (emailCheck.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Check CNIC exists
    const cnicCheck = await execute(
      'SELECT user_id FROM users WHERE cnic = ? ALLOW FILTERING',
      [cnic]
    );
    if (cnicCheck.rows.length > 0) {
      return res.status(409).json({ error: 'CNIC already registered' });
    }

    // Role-specific validation
    if (roleUpper === 'MANUFACTURER' && (!company_name || !factory_address || !product_categories)) {
      return res.status(400).json({ error: 'company_name, factory_address, product_categories required for MANUFACTURER' });
    }
    if (roleUpper === 'DISTRIBUTOR' && (!company_name || !warehouse_address || !coverage_areas)) {
      return res.status(400).json({ error: 'company_name, warehouse_address, coverage_areas required for DISTRIBUTOR' });
    }
    if (roleUpper === 'RETAILER' && (!store_name || !store_address || !store_type)) {
      return res.status(400).json({ error: 'store_name, store_address, store_type required for RETAILER' });
    }
    if (roleUpper === 'CUSTOMER' && (!delivery_address)) {
      return res.status(400).json({ error: 'delivery_address required for CUSTOMER' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = cassandra.types.Uuid.random();

    let org_name = full_name;
    if (roleUpper === 'MANUFACTURER') org_name = company_name;
    if (roleUpper === 'DISTRIBUTOR')  org_name = company_name;
    if (roleUpper === 'RETAILER')     org_name = store_name;

    // Insert user
    await execute(
      `INSERT INTO users (user_id, email, password, full_name, phone, cnic,
        profile_pic, role, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, true, toTimestamp(now()), toTimestamp(now()))`,
      [userId, email.toLowerCase(), hashedPassword, full_name, phone, cnic,
       profile_pic || null, roleUpper]
    );

    // Insert role profile
    if (roleUpper === 'MANUFACTURER') {
      await execute(
        `INSERT INTO manufacturer_profiles (user_id, company_name, registration_number,
          factory_address, city, country, product_categories, employee_count,
          website, company_logo, established_year, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, toTimestamp(now()))`,
        [userId, company_name, registration_number || null, factory_address,
         city || null, country || 'Pakistan', product_categories,
         employee_count || null, website || null, company_logo || null,
         established_year || null]
      );
    }

    if (roleUpper === 'DISTRIBUTOR') {
      await execute(
        `INSERT INTO distributor_profiles (user_id, company_name, registration_number,
          warehouse_address, city, country, coverage_areas, fleet_size,
          storage_capacity, company_logo, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, toTimestamp(now()))`,
        [userId, company_name, registration_number || null, warehouse_address,
         city || null, country || 'Pakistan', coverage_areas,
         fleet_size || null, storage_capacity || null, company_logo || null]
      );
    }

    if (roleUpper === 'RETAILER') {
      await execute(
        `INSERT INTO retailer_profiles (user_id, store_name, license_number,
          store_address, city, country, store_type, store_size,
          store_logo, opening_hours, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, toTimestamp(now()))`,
        [userId, store_name, license_number || null, store_address,
         city || null, country || 'Pakistan', store_type,
         store_size || null, store_logo || null, opening_hours || null]
      );
    }

    if (roleUpper === 'CUSTOMER') {
      await execute(
        `INSERT INTO customer_profiles (user_id, delivery_address, city,
          country, date_of_birth, gender, created_at)
         VALUES (?, ?, ?, ?, ?, ?, toTimestamp(now()))`,
        [userId, delivery_address, city || null, country || 'Pakistan',
         date_of_birth || null, gender || null]
      );
    }

    const token = jwt.sign(
      { userId: userId.toString(), email: email.toLowerCase(), full_name, phone, cnic, role: roleUpper, org_name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      success: true,
      token,
      user: { userId: userId.toString(), email: email.toLowerCase(), full_name, phone, cnic, role: roleUpper, org_name }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Login ────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const result = await execute(
      'SELECT * FROM users WHERE email = ? ALLOW FILTERING',
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user  = result.rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'Account is deactivated' });
    }

    let profile = {};
    if (user.role === 'MANUFACTURER') {
      const p = await execute('SELECT * FROM manufacturer_profiles WHERE user_id = ?', [user.user_id]);
      profile = p.rows[0] || {};
    } else if (user.role === 'DISTRIBUTOR') {
      const p = await execute('SELECT * FROM distributor_profiles WHERE user_id = ?', [user.user_id]);
      profile = p.rows[0] || {};
    } else if (user.role === 'RETAILER') {
      const p = await execute('SELECT * FROM retailer_profiles WHERE user_id = ?', [user.user_id]);
      profile = p.rows[0] || {};
    } else if (user.role === 'CUSTOMER') {
      const p = await execute('SELECT * FROM customer_profiles WHERE user_id = ?', [user.user_id]);
      profile = p.rows[0] || {};
    }

    let org_name = user.full_name;
    if (profile.company_name) org_name = profile.company_name;
    if (profile.store_name)   org_name = profile.store_name;

    const token = jwt.sign(
      { userId: user.user_id.toString(), email: user.email, full_name: user.full_name, phone: user.phone, cnic: user.cnic, role: user.role, org_name, profile },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: { userId: user.user_id.toString(), email: user.email, full_name: user.full_name, phone: user.phone, cnic: user.cnic, role: user.role, org_name, profile }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Get current user ─────────────────────────────────────────────────────
router.get('/me', (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ user: decoded });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// ─── Available roles ──────────────────────────────────────────────────────
router.get('/roles/available', async (req, res) => {
  try {
    const result = await execute('SELECT role FROM users ALLOW FILTERING', []);
    const takenRoles = [...new Set(result.rows.map(r => r.role))];
    const available = VALID_ROLES.filter(r => r === 'CUSTOMER' || !takenRoles.includes(r));
    res.json({ available, taken: takenRoles.filter(r => r !== 'CUSTOMER') });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
