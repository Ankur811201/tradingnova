'use strict';

const { v4: uuidv4 } = require('uuid');

function generateId(prefix) {
  return `${prefix}_${uuidv4()}`;
}

module.exports = {
  generateId,
  newOrderId: () => generateId('ord'),
  newCommandId: () => generateId('cmd'),
  newInstanceId: () => generateId('inst'),
  newTradeId: () => generateId('trd'),
};
