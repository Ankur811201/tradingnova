'use strict';

const portfolioService = require('../services/portfolio/PortfolioService');
const { success } = require('../utils/apiResponse');

async function getPaperPortfolio(req, res, next) {
  try {
    const portfolio = await portfolioService.getPaperPortfolio(req.session.userId);
    return success(res, portfolio);
  } catch (err) {
    return next(err);
  }
}

async function getLivePortfolio(req, res, next) {
  try {
    const portfolio = await portfolioService.getLivePortfolio();
    return success(res, portfolio);
  } catch (err) {
    return next(err);
  }
}

module.exports = { getPaperPortfolio, getLivePortfolio };
