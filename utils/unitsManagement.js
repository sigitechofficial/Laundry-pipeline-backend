const customError = require('../middlewares/customError');
//import models
const { baseUnits, units, appUnits } = require("../models");

//^ Return current appunit id
async function currentAppUnitsId() {
    try {
        const currentUnits = await appUnits.findOne({ where: { status: true } });
        return currentUnits.id;
    } catch (error) {
        console.log("🚀 ~ file: unitsManagement.js:12 ~ currentAppUnits ~ error:", error);
    }
}

//^ Return the names, symbols and conversion rates of givien appunit id
async function unitsSymbolsAndRates(appUnitId) {
    try {
        const symbols = await appUnits.findByPk(appUnitId, {
            include: [
                { model: units, as: 'weightUnit', attributes: ['name', 'symbol', 'conversionRate'] },
                { model: units, as: 'lengthUnit', attributes: ['name', 'symbol', 'conversionRate'] },
                { model: units, as: 'distanceUnit', attributes: ['name', 'symbol', 'conversionRate'] },
                { model: units, as: 'currencyUnit', attributes: ['name', 'symbol', 'conversionRate'] },
            ]
        });
        const output = {
            symbol:
            {
                weight: symbols.weightUnit.symbol,
                length: symbols.lengthUnit.symbol,
                distance: symbols.distanceUnit.symbol,
                currency: symbols.currencyUnit.symbol,
            },
            conversionRate:
            {
                weight: symbols.weightUnit.conversionRate,
                length: symbols.lengthUnit.conversionRate,
                distance: symbols.distanceUnit.conversionRate,
                currency: symbols.currencyUnit.conversionRate,// not in use yet 
            },
            names:
            {
                weight: symbols.weightUnit.name,
                length: symbols.lengthUnit.name,
                distance: symbols.distanceUnit.name,
                currency: symbols.currencyUnit.name,
            }
        };
        return output;

    } catch (error) {
        console.log("🚀 ~ file: unitsManagement.js:12 ~ currentAppUnits ~ error:", error);
    }
}


//^ Convert Values to Current Units
function unitsConversion(value, conversionRate) {
    const output = (parseFloat(value) / parseFloat(conversionRate)).toFixed(2) //base to current
    return parseFloat(output);
}

//^ Convert Value to Base Units
function convertToBaseUnits(value, conversionRate) {
    const output = (parseFloat(value) * parseFloat(conversionRate)).toFixed(2) //current to base
    return parseFloat(output);
}

module.exports = {
    currentAppUnitsId, unitsConversion, unitsSymbolsAndRates, convertToBaseUnits
};

