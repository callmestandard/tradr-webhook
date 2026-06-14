'use strict';

const express = require('express');
const router = express.Router();
const { partnerAuth } = require('../../../middleware/partnerAuth');
const traderRoutes = require('./traders');
const assessmentRoutes = require('./assessments');

// Version header on every response from this namespace
router.use((req, res, next) => {
  res.setHeader('X-TRADR-API-Version', '2026-06-09');
  next();
});

router.use(partnerAuth);
router.use('/traders', traderRoutes);
router.use('/assessments', assessmentRoutes);

module.exports = router;
