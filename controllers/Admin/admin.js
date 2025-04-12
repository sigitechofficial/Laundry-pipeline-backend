require("dotenv").config();
const { users,
    userType,
    booking,
    otpVerification,
    deviceToken,
    vehicleType,
    countries,
    cities,
    roles,
    zone,
    categories,
    service,
    subCategories,
    reason,
    machines,
    classifiedAs,
    servicePreferences,
    preferencesServiceName,
    onHoldOption,
    onHoldCustomerOption,
    addressDb,
    customerSelectedService,
    OnHoldConfirmation,
    bookingStatus,
    driverInZones,
    bussinessInformation } = require('../../models')
const sequelize = require('sequelize')
const { Op } = require('sequelize')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
var JSbarcode = require('jsbarcode')
const redisCli = require('../../redis/redis')
const otpGenerator = require('otp-generator')
const customError = require('../../middlewares/customError')
const otpMail = require('../../helper/otpMail')
const error = require('../../middlewares/error')
const path = require('path')
const { stat } = require('fs')
const stripe = require('../stripe')
const {
    currentAppUnitsId,
    unitsConversion,
    unitsSymbolsAndRates,
    convertToBaseUnits,
} = require('../../utils/unitsManagement');
const { type } = require("os");
const { group } = require("console");
const { literal } = require('sequelize');
const { registerCustomer } = require("../Customer/customerAuth");

//!----------------------------------Customer Management-----------------------------------------//

/*
  * Get All Customers
*/
async function getAllCustomers(req, res) {

    const findCustomers = await users.findAll({
        where: {
            userTypeId: 2
        },
        attributes: [
            'id',
            'firstName',
            'lastName',
            'phoneNum',
            'status',
            [sequelize.fn('COUNT', sequelize.col('customer.id')), 'bookingCount']
        ],
        include: [
            {
                model: booking,
                as: 'customer',
                attributes: []
            }
        ],
        group: ['users.id']
    })


    return res.json(responsefunc("1", "All Customer Details", findCustomers, ""))

}

/*
   * Customers Count
*/
async function customerCount(req, res) {

    const customerCount = await users.count({
        where: {
            userTypeId: 2
        }
    }
    )
    console.log("🚀 ~ customerCount ~ customerCount:", customerCount)


    const fourDayAgo = new Date();
    console.log("🚀 ~ customerCount ~ fouDayAgo:", fourDayAgo)
    fourDayAgo.setDate(fourDayAgo.getDate() - 4)


    const recentCustomer = await users.count({
        where: {
            userTypeId: 2,
            createdAt: {
                [Op.gte]: fourDayAgo
            }
        }
    })

    const activeUser = await users.count({
        where: {
            status: true,
            userTypeId: 2
        }
    })

    const repeatCustomers = await booking.findAll({
        attributes: [
            'customerId',
            [sequelize.fn('COUNT', sequelize.col('customerId')), 'RepeatingCustomerCount']
        ],
        group: ['customerId'],
        having: sequelize.literal('COUNT(customerId) > 1'),
        order: [[sequelize.fn('COUNT', sequelize.col('customerId')), 'DESC']],
        include: [
            {
                model: users,
                as: 'customer',
                attributes: ['id', 'email', 'firstName', 'lastName']
            }
        ]
    })

    const repeatCustomersCount = repeatCustomers.length


    let outObj = {
        TotalCustomer: customerCount,
        NewCustomers: recentCustomer,
        activeUser: activeUser,
        RepeatedCustomers: repeatCustomersCount

    }

    return res.json(responsefunc("1", "All Customer Count", outObj, ""))
}



/*
  * Specific Customer Details
*/

async function specificCustomerDetails(req, res) {
    const { customerId } = req.params

    const bookingsFind = await booking.findAll({
        where: {
            customerId: customerId,
        },
        include:[
            {
                model:customerSelectedService,
                attributes:['id','date','time','items','serviceId','categoryPrice']
            },
            {
                model:OnHoldConfirmation,
                required:false,
                attributes:['onHoldImg','noOfItems','description','bookingId']
            },
            {
                model:addressDb,
                as:'laundryShop',
                include:{
                    model:bussinessInformation,
                    attributes:['shopName']
                },
                attributes:['id']
            },
            {
                model:bookingStatus,
                attributes:['title','description']
            }
        ],
        order:[['id','DESC']],
        attributes: {
            exclude: ['updatedAt', 'categoryId', 'serviceId', 'subCategoryId', 'vehicleTypeId']
        }
    })
    console.log("🚀 ~ specificCustomerDetails ~ bookingsFind:", bookingsFind)
    
    const userInfo=await addressDb.findAll({
        where:{
            userId:customerId
        },
        include:[{
            model:users,
            attributes:['id','firstName','lastName','email']
        }],
        order:[
            ['createdAt','DESC']
        ],
        limit:1,
        attributes:['id','title','streetAddress','district','province','lat','lng','status','addressType','userId']
    })

    const bookingIds=bookingsFind.map((ids) =>({
       bookingIDS:ids.id
    }))
    console.log("🚀 ~ bookingIds ~ bookingIds:", bookingIds)

    let output={
        bookingDetails:bookingsFind,
        userDetails:userInfo
    }

    return res.json(responsefunc("1", "Custome Order Details", output, ""))
}
//!----------------------------------------------------Drivers Management--------------------------------------->>
/* 
 *  Drivers Count
*/
async function countTotalDrivers(req,res) {
    const driverCount=await users.count({
        where:{
            roleId:6,
            classifiedAsId:1
        }
    })

    const shopAgentDrivers=await users.count({
        where:{
            roleId:6,
            classifiedAsId:1
        }
    })

    const availableDrivers=await users.count({
       where:{
        status:true,
        classifiedAsId:1,
        roleId:6
        }
    })

    let outObj={
        totalDrivers:driverCount,
        shopAgentDrivers:shopAgentDrivers,
        availableDrivers:availableDrivers
    }

    return res.json(responsefunc("1","All Counts Fetched",outObj,""))
}


/* 
 *  All Drivers Detail 
*/
async function allDriverMiniDetails(req,res){

    const findDriver=await booking.findAll({
        where:{
            driverId:{
                [Op.ne]:null
            },
            deliveryDriverId:{
                [Op.ne]:null
            }
        },
        attributes:[
            'driverId',
        [sequelize.fn('COUNT',sequelize.col('driverId')),'DriverPickUpOrders'],
        [sequelize.fn('COUNT',sequelize.col('deliveryDriverId')),'DriverDeliveryOrders'],
        ],
        include:[
            {
                model:users,
                as:'driver',
                where:{
                    status:true
                },
                attributes:['id','firstName','lastName','email','userTypeId','classifiedAsId','roleId'],
                include:[
                    {
                        model:roles,
                        attributes:['name']
                    }
                ]
            }
        ],
        group:['driverId','deliveryDriverId'],
    })
    return res.json(responsefunc("1","Drivers Details fetched",findDriver,""))
}


/* 
 *  All Drivers Detail 
*/
async function driverStatusChange(req,res) {
    const{driverId}=req.params

    const driverStatusChange=await users.update({
        status:false
    },{where:{
        id:driverId
    }})

    return res.json(responsefunc("1","Driver Status Updated",driverStatusChange,""))
    
}

/* 
 *   Specific Driver Detail  
*/
async function specificdriverDetail(req,res) {
    const{driverId}=req.params

    const userInfo=await driverInZones.findOne({
        where:{
            driverId:driverId,
        },
        include:[
            {
                model:users,
                as:'driverInZone',
                attributes:['id','firstName','lastName','email'],
                include:[
                    {
                        model:roles,
                        attributes:['name']
                    }
                ]
            },
            {
                model:bussinessInformation,
                as:'laundaryDriver',
                attributes:['shopName','shopAddressId'],
                include:[{
                    model:addressDb,
                    attributes:['streetAddress','province','district','addressType']
                }]
            }
        ],
        attributes:['laundaryShopId']
    })

    const findBooking=await booking.findAll({
        where:{
            driverId:driverId,
            [Op.or]:[
                {driverId:driverId},
                {deliveryDriverId:driverId}
            ]
        }
    })

    let outObj={
        userInformation:userInfo,
        driverBookings:findBooking
    }


    return res.json(responsefunc("1",`All booking Fetched for Driver id:${driverId}`,outObj,""))
    
}



//!----------------------------------------------------Add Countries,Cities,Zones && Zone Details--------------------------------------->>
/* 
 *  Add Countries
*/
async function addCountries(req, res) {
    const { name, shortName } = req.body

    let flagImg = null;

    if (req.file) {
        let tempImage = req.file.path;
        flagImg = tempImage.replace(/\\/g, "/")
    }

    const countryCreate = await countries.create({
        name,
        shortName,
        image: flagImg,
        status: true
    })

    return res.json(responsefunc("1", "Country Added Sucessfully", countryCreate, ""))

}

/*
   * Get Countries
*/

async function getCountries(req, res) {

    const getCountry = await countries.findAll()

    return res.json(responsefunc("1", "All Countries fetched", getCountry, ""))

}


/*
   * Add Cities
*/

async function addCities(req, res) {
    const { name, lat, lng, countryId } = req.body

    const addCity = await cities.create({
        name,
        lat,
        lng,
        status: true,
        countryId
    })

    return res.json(responsefunc("1", "City Added Sucessfully", addCity, ""))

}

/*
   * Get Cities
*/

async function getCities(req, res) {

    const getCities = await cities.findAll()

    return res.json(responsefunc("1", "All Cities Fetched", getCities, ""))

}


/*
   * Add Zones
*/

async function addZones(req, res) {
    const { name, coordinates, cityId } = req.body

    const polygon = {
        type: 'Polygon',
        coordinates: coordinates
    }

    const zoneCreate = await zone.create({
        name,
        coordinates: polygon,
        status: true,
        cityId,
        zoneMinimumAmount
    })

    return res.json(responsefunc("1", "Zone Added Sucessfully", zoneCreate, ""))

}


/*
   * Get Zones
*/

async function getZones(req, res) {

    const getZones = await zone.findAll()

    return res.json(responsefunc("1", "All Zones Fetched Sucessfully", getZones, ""))

}

//!-----------------------Add Services,Categories and SubCategories --------------------//
/*

*  Add Services

*/
async function AddServices(req, res) {
    const services = req.body
    console.log("🚀 ~ AddServices ~ req.body:", req.body)

    if (!Array.isArray(services) || services.length === 0) {
        throw new customError("Invalid request. Please provide an array of services.")
    }

    const createService = await service.bulkCreate(
        services.map((service) => ({
            ...service,
            status: true
        }))
    )

    return res.json(responsefunc("1", "Services Added Sucessfully", createService, ""))

}


/*
*  Get All Services
*/
async function getAllServices(req, res) {

    const getServices = await service.findAll({
        where: {
            status: true,
        }
    })
    return res.json(responsefunc("1", "All Services", getServices, ""))
}

/*
  * Add Categories
*/
async function AddCategories(req, res) {
    const { name } = req.body

    let CategoryImg = null;

    if (req.file) {

        let tempImage = req.file.path;
        CategoryImg = tempImage.replace(/\\/g, "/")

    }

    const category = await categories.create({
        name,
        image: CategoryImg,
    })

    return res.json(responsefunc("1", "Category Added Sucessfully", category))

}


/*
  * Get All Categories
*/
async function getCategories(req, res) {

    const getCategories = await categories.findAll()

    return res.json(responsefunc("1", "All Categories Fetched", getCategories))

}


/*
  * Add SubCategories
*/
async function addSubCategories(req, res) {
    const categoryData = req.body
    console.log("🚀 ~ addSubCategories ~ req.body:", req.body)

    const createSubCategories = await subCategories.bulkCreate(
        categoryData.map((categories) => ({
            ...categories,
            status: true
        }))
    )

    if (!createSubCategories) {
        throw new customError("There is error in the request")
    }

    return res.json(responsefunc("1", "SubCategories Added Sucessfully", createSubCategories, ""))

}


/*
  * Get SubCategories
*/
async function getSubcategories(req, res) {

    const getSubcategories = await subCategories.findAll()

    return res.json(responsefunc("1", "All SubCategories Fetched", getSubcategories, ""))
}

//!-----------------------------------Driver && Vechicles------------------------------------------->>
/* 
 *  Add vehicle
*/

async function addVehicle(req, res) {
    let { title, baseRate, perUnitRate, weightCapacity, volumeCapacity } =
        req.body;
    const appUnitId = await currentAppUnitsId();
    const units = await unitsSymbolsAndRates(appUnitId);
    weightCapacity = convertToBaseUnits(
        weightCapacity,
        units.conversionRate.weight
    );
    volumeCapacity = convertToBaseUnits(
        volumeCapacity,
        units.conversionRate.length
    );
    const vehicleExist = await vehicleType.findOne({
        where: { title, status: true },
    });
    if (vehicleExist)
        throw new CustomException(
            "A vehicle with the same name already exists",
            " Please try some other name"
        );
    // check on image
    let imagePath = "";
    if (req.file) {
        let tmpPath = req.file.path;
        imagePath = tmpPath.replace(/\\/g, "/");
        // getting units
    } else {
        imagePath = ""; // throw new CustomException('Image not uploaded', 'Please upload image');
    }
    const created = await vehicleType.create({
        title,
        status: true,
        image: imagePath,
        baseRate,
        perUnitRate,
        weightCapacity,
        volumeCapacity,
    });
    return res.json(responsefunc("1", "Vehicle added", created, ""));
}

//!----------------------------------Cancel Booking Reasons---------------------------------//
/*
  *  Cancel Booking Reasons
*/
async function cancelBooking(req, res) {
    const { cancelReason } = req.body
    const reasonCreate = await reason.create({
        cancelReason
    })
    return res.json(responsefunc("1", "Reason Added ", reasonCreate, ""))

}


/*
  *  Get All Cancel Booking Reasons
*/

async function getCancelBookingReasons(req, res) {
    const getBooking = await reason.findAll({
        attributes: ['id', 'cancelReason']
    })
    return res.json(responsefunc("1", "All Cancel Booking reasons fetched", getBooking, " "))

}

//!------------------------Admin Create Roles,Classicifations,Permissions-------------------------//
async function laundryRoles(req, res) {
    const { name, status } = req.body
    const roleCreation = await roles.create({
        name,
        status
    })

    return res.json(responsefunc("1", "Roles Added SucessFully", roleCreation, " "))

}




//!--------------------------------------------Add Machines-----------------------------------------------//
/*
  * Add Machines
*/

async function addMachines(req, res) {
    const { name } = req.body

    const findMachine = await machines.findOne({
        where: {
            name: name
        }
    })
    if (findMachine) {
        throw new customError("Machine Already Exists")
    }
    const createMachine = await machines.create({
        name,
        status: true
    })
    return res.json(responsefunc("1", "Machine Added", createMachine, " "))

}



//!-----------------------------Add Match Preferences-------------------------//
/*
  * Add Preferences
*/
async function AddServicePreferences(req, res) {
    const { title } = req.body

    const findPref = await preferencesServiceName.findOne({
        where: {
            title: title,
            status: true
        }
    })

    if (findPref) {
        throw new customError('Title Already Exists')
    }

    const createPreferences = await preferencesServiceName.create({
        title,
        status: true
    })

    return res.json(responsefunc("1", "Service Preferences Added Sucessfully", createPreferences, ""))
}

/*
  * Get Account Preferences
*/
async function getAccountPreferences(req, res) {

    const preFind = await preferencesServiceName.findAll({
        attributes: ['title', 'status']
    })

    return res.json(responsefunc("1", "All Account Preferences Fetched", preFind, ""))

}

//!------------------------On Hold Options-------------------//

/*
  * Add On Hold Options
*/
async function onHoldOptions(req, res) {
    const { option } = req.body

    const optionValues = option.map(item => item.option);
    console.log("🚀 ~ onHoldOptions ~ optionValues:", optionValues)

    const optionFind = await onHoldOption.findAll({
        where: {
            option: optionValues
        }
    })
    console.log("🚀 ~ onHoldOptions ~ optionFind:", optionFind)

    if (optionFind.length > 0) {
        throw new customError('Some Options Already Exists')
    }

    const optionsCreate = await onHoldOption.bulkCreate(
        option.map(opt => ({
            option: opt.option,
            status: true
        }))
    );

    return res.json(responsefunc("1", "on Hold Options Created", optionsCreate, ""))


}


/*
  * Get On Hold Options
*/

async function getOnHoldOptions(req, res) {

    const getOptions = await onHoldOption.findAll({
        where: {
            status: true
        }
    })

    return res.json(responsefunc("1", "All on Hold Options Fetched", getOptions, ""))

}




/*
  * Add On Hold Customer Options
*/
async function customerOnHoldOptions(req, res) {
    const { option, onHoldOptionId } = req.body

    const optionValues = option.map(item => item.option);

    const optionFind = await onHoldCustomerOption.findAll({
        where: {
            option: optionValues
        }
    })
    console.log("🚀 ~ customerOnHoldOptions ~ optionFind:", optionFind)

    if (optionFind.length > 0) {
        throw new customError('Some Options Already Exists')
    }

    const optionsCreate = await onHoldCustomerOption.bulkCreate(
        option.map(opt => ({
            title: opt.title,
            option: opt.option,
            conformationText: opt.confirmationText,
            notConfirmText: opt.notConfirmText,
            onHoldOptionId: opt.onHoldOptionId,
            status: true
        }))
    )


    return res.json(responsefunc("1", "Customer Hold Option", optionsCreate, ""))
}


/*
  * Get On Hold Customer Options
*/
async function getOnHoldCustomerOptions(req, res) {

    const optionsFound = await onHoldCustomerOption.findAll({
        include: [{
            model: onHoldOption,
            where: {
                status: true
            },
            attributes: ['id', 'option', 'status']
        }],
        attributes: ['id', 'option', 'title', 'conformationText', 'notConfirmText', 'onHoldOptionId']
    })

    return res.json(responsefunc("1", "All Options Fetched", optionsFound, ""))

}




/*
  * Add On Hold Customer Options && On Hold Options synchronously
*/
async function createOnHoldOptionsAndCustomerOptions(req, res) {
    try {
        const { option, customerOptions } = req.body; // Receive customerOptions separately

        if (!Array.isArray(option) || option.length === 0 || !Array.isArray(customerOptions) || customerOptions.length === 0) {
            throw new customError("Invalid input: Expected non-empty arrays for both options and customerOptions.");
        }

        if (option.length !== customerOptions.length) {
            throw new customError("Mismatch: option array and customerOptions array must have the same length.");
        }

        const optionValues = option.map(item => item.option);
        console.log("🚀 ~ optionValues:", optionValues);

        const existingOptions = await onHoldOption.findAll({
            where: { option: optionValues }
        });

        if (existingOptions.length > 0) {
            throw new customError("Some Options Already Exist");
        }

        const createdOnHoldOptions = await onHoldOption.bulkCreate(
            option.map(opt => ({
                option: opt.option,
                status: true
            })),
            { returning: true }
        );

        console.log("🚀 ~ createdOnHoldOptions:", createdOnHoldOptions);


        const customerOptionsData = customerOptions.map((custOpt, index) => ({
            option: custOpt.option,
            onHoldOptionId: createdOnHoldOptions[index].id,
            status: true
        }));

        const createdOnHoldCustomerOptions = await onHoldCustomerOption.bulkCreate(customerOptionsData);

        return res.json(responsefunc("1", "On Hold Options and Customer Options Created", {
            onHoldOptions: createdOnHoldOptions,
            onHoldCustomerOptions: createdOnHoldCustomerOptions
        }, ""));
    } catch (error) {
        console.error("🚀 ~ Error in createOnHoldOptionsAndCustomerOptions:", error);
        return res.status(500).json(responsefunc("0", error.message, null, ""));
    }
}



//!Recurring functions
let responsefunc = (status, message, data, error) => {
    return {
        status: `${status}`,
        messsage: `${message}`,
        data: data,
        error: `${error}`
    }
}


//!-------------------Exports----------------//
module.exports = {
    //-------------Vehicles--------//
    addVehicle,
    //-------------Countries,Cities--------//
    addCountries,
    addCities,
    getCities,
    getCountries,
    //-------------Add Zones--------//
    addZones,
    getZones,
    //-------------Categories,SubCategories--------//
    AddCategories,
    addSubCategories,
    getCategories,
    getSubcategories,
    //-------------Services--------//
    getAllServices,
    AddServices,
    //-------------Cancel Booking--------//
    cancelBooking,
    getCancelBookingReasons,
    //-------------Laundry Roles--------//
    laundryRoles,
    //-------------Machinery--------//
    addMachines,
    //------------Account Preferences-----------//
    AddServicePreferences,
    getAccountPreferences,
    //--------on Hold Option------------//
    onHoldOptions,
    customerOnHoldOptions,
    getOnHoldCustomerOptions,
    getOnHoldOptions,
    //------------Customer Management-------//
    getAllCustomers,
    customerCount,
    specificCustomerDetails,
    //-----------Driver Management----------//
    countTotalDrivers,
    allDriverMiniDetails,
    driverStatusChange,
    specificdriverDetail
}