'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Sequelize = require('sequelize');
const process = require('process');
const basename = path.basename(__filename);
const env = process.env.NODE_ENV || 'development';
const config = require(__dirname + '/../config/config.json')[env];
const { guardSequelizeSync } = require('../utils/guardSequelizeSync');
const { sequelizePoolFromEnv } = require('../utils/sequelizePool');
const db = {};

const sequelizeOptions = {
  ...config,
  pool: {
    ...(config.pool || {}),
    ...sequelizePoolFromEnv(process.env),
  },
};

let sequelize;
if (config.use_env_variable) {
  sequelize = new Sequelize(process.env[config.use_env_variable], sequelizeOptions);
} else {
  sequelize = new Sequelize(
    config.database,
    config.username,
    config.password,
    sequelizeOptions
  );
}

// Reject alter/force sync in production even if laundary.js syncDb is flipped.
guardSequelizeSync(sequelize, env);

fs
  .readdirSync(__dirname)
  .filter(file => {
    return (
      file.indexOf('.') !== 0 &&
      file !== basename &&
      file.slice(-3) === '.js' &&
      file.indexOf('.test.js') === -1
    );
  })
  .forEach(file => {
    const model = require(path.join(__dirname, file))(sequelize, Sequelize.DataTypes);
    db[model.name] = model;
  });

Object.keys(db).forEach(modelName => {
  if (db[modelName].associate) {
    db[modelName].associate(db);
  }
});

db.sequelize = sequelize;
db.Sequelize = Sequelize;

module.exports = db;
