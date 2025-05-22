require("dotenv").config();
const { users,
    userType,
    booking,
    otpVerification,
    deviceToken,
    bookingHistory,
    billingDetails,
    categories,
    subCategories,
    addressDb,
    customerSelectedService,
    bookingStatus,
    service,
    zone,
    OnHoldConfirmation,
    proofOfDeliveries,
    bussinessInformation,
    onHoldOption,
    onHoldCustomerOption,
    serviceCategories,
    servicePreferences } = require('../../models')
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
const { stat, rmSync } = require('fs')
const stripe = require('../stripe')
const { request } = require("http");
const checkServiceAvailability = require('../../utils/haversineFormula')
const { literal, fn, col } = require('sequelize');
const getdistance = require('../../utils/distanceCalculator');
const { sendEvent } = require('../../socket_io');
const { title } = require("process");








//!------------------------Boooking Management-------------------------------//
/*
 *   Customer Create Booking
*/

async function createBooking(req, res) {
    const { collectionDate,
        collectionTimeFrom,
        collectionTimeTo,
        driverInstruction,
        frequency,
        deliveryDate,
        deliveryTimeFrom,
        deliveryTimeTo,
        pickUpAddress,
        dropOffAddress,
        addNewAddress,
        addNewDropOffAddress,
        dropOffSamePickUp,
        dropOffAddressId,
        pickUpAddressId,
        services,
        totalItems,
        addressId,
        driverInstructionOptions,
        driverInstructionOptions1,
        preferencesArray } = req.body;

    console.log("🚀 ~ createBooking ~ req.body:", req.body);

    const userId = req.user.id;
    let userAddressId;
    let userPickUpAddressId;
    let userDropOffAddressId;

    console.log("Lat -------------->", pickUpAddress.lat);
    console.log("Lng ---------------------->", pickUpAddress.lng);

    let findZone = await findZones(pickUpAddress.lat, pickUpAddress.lng);
    let zoneId = findZone[0].id;
    let zoneUpfrontAmount = findZone[0].zoneMinimumAmount
    let zoneSeviceCharge = findZone[0].serviceCharge
    console.log("🚀 ~ createBooking ~ findZone:", zoneId);
    console.log("🚀 ~ createBooking ~ findZone:", zoneUpfrontAmount);
    console.log("🚀 ~ createBooking ~ findZone:", zoneSeviceCharge);

    //return res.json(findZone)

    if (addNewAddress || !pickUpAddressId) {
        userAddressId = await addressAdder(addNewAddress, pickUpAddress, "pickUp", userId, pickUpAddressId);
        userPickUpAddressId = userAddressId;
    } else {
        userPickUpAddressId = pickUpAddressId;
    }

    if (dropOffSamePickUp === true) {
        userDropOffAddressId = userPickUpAddressId;
    } else if (addNewDropOffAddress || !dropOffAddressId) {
        userDropOffAddressId = await addressAdder(addNewAddress, dropOffAddress, "dropOff", userId);
    } else {
        userDropOffAddressId = dropOffAddressId;
    }

    const orderTrackingId = otpGenerator.generate(6, {
        lowerCaseAlphabets: false,
        upperCaseAlphabets: false,
        specialChars: false
    });

    const createPreferences = preferencesArray.map((preferences) => ({
        type: preferences.type,
        chooseTemperature: preferences.chooseTemperature,
        serviceId: preferences.serviceId,
        preferencesServiceNameId: preferences.preferencesServiceNameId,
        numberOfBags: preferences.numberOfBags
    }))



    await servicePreferences.bulkCreate(createPreferences)


    const bookingData = await booking.create({
        collectionDate,
        collectionTimeFrom,
        collectionTimeTo,
        driverInstruction,
        frequency,
        deliveryDate,
        deliveryTimeFrom,
        deliveryTimeTo,
        customerId: userId,
        bookingStatusId: 1,
        pickupAddresId: userPickUpAddressId,
        dropOffAddressId: userDropOffAddressId,
        totalItems: totalItems || 0,
        paymentConfirmed: false,
        partialPayment: false,
        zoneId:zoneId,
        driverInstructionOptions,
        driverInstructionOptions1
    });


    let total = 0;
    let categoryCharge = 0;

    const currentTime = new Date().toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
    const currentDate = new Date().toISOString().split('T')[0];
    console.log(currentDate); // Example: "2025-01-28"
    console.log(currentTime); // Example: "14:35"

    const discount = 0;
    if (services && services.length > 0) {
        categoryCharge = services.reduce(
            (acc, service) => acc + parseFloat(service.categoryCharge || 0),
            0
        );
        // Calculate total amount
        total = categoryCharge;

        // Prepare the serviceData to be inserted
        const serviceData = services.map((service) => {
            let serviceObj = {
                bookingId: bookingData.id,
                serviceId: service.serviceId,
                date: currentDate,
                time: currentTime,
            };
            if (service.categoryId) serviceObj.categoryId = service.categoryId;
            if (service.subCategoryId) serviceObj.categoryId = service.categoryId;
            if (service.categoryCharge) serviceObj.categoryPrice = total

            return serviceObj;
        });
        console.log("🚀 ~ createBooking ~ serviceData:", serviceData);
        let serviceCreate = await customerSelectedService.bulkCreate(serviceData);
        console.log("🚀 ~ createBooking ~ serviceCreate:", serviceCreate);
    } else if (services.length === 0) {
        throw new customError("Cannot Continue without Selection of Service Types", "Select Minimum one Service Type")
    }

    const ordertrackingNumber = `${bookingData.id}-${orderTrackingId}`;
    const upfrontAmount = zoneUpfrontAmount;
    console.log("🚀 ~ createBooking ~ upfrontAmount:", upfrontAmount);

    const fixTimeKey = new Date(Date.now() + 40 * 60 * 1000).toLocaleTimeString(
        'en-GB',
        {
            hour12: false, // Forces 24-hour format
            hour: "2-digit",
            minute: "2-digit",
        }
    );
    console.log("🚀 ~ createBooking ~ fixTimeKey:", fixTimeKey)


    // Create the billing details
    await billingDetails.create({
        bookingId: bookingData.id,
        upfrontAmount,
        discount,
        paymentStatus: 'Pending'
    });


    await bookingHistory.create({
        date: currentDate,
        time: currentTime,
        bookingId: bookingData.id,
        bookingStatusId: 1
    });

    await booking.update({
        orderAmount: total || 0,
        orderTrackId: ordertrackingNumber,
        orderExpireTime: fixTimeKey
    }, { where: { id: bookingData.id } });


    let bookingId = bookingData.id
    bookingEventSentCheckTheShops(bookingId, zoneId, collectionDate, collectionTimeTo, deliveryDate, deliveryTimeTo)


    return res.json(responsefunc("1", "Booking Created", {}, ""));
}


/*
  * Show Customer On Hold Reason
*/
async function onHoldCustomerShow(req, res) {
    const { bookingId } = req.body

    const userFound = await booking.findOne({
        where: {
            id: bookingId
        },
        include: [
            {
                model: users,
                as: 'customer',
                attributes: ['id', 'email']
            }
        ]
    })
    console.log("🚀 ~ onHoldCustomerShow ~ userFound:", userFound.customer.id)


    const optionIdFound = await OnHoldConfirmation.findOne({
        where: {
            bookingId: bookingId
        },
        include: [{
            model: onHoldOption,
            as: 'agentHoldId',
        }],
        attributes: ['onHoldOptionId']
    })
    console.log("🚀 ~ onHoldCustomerShow ~ optionIdFound:", optionIdFound)


    const customerOptionFound = await onHoldCustomerOption.findOne({
        where: {
            onHoldOptionId: optionIdFound.onHoldOptionId
        },
        attributes: ['id', 'option', 'title', 'conformationText', 'notConfirmText']
    })

    return res.json(responsefunc("1", "Customer On Hold Response Show", customerOptionFound, ""))
}



/*
 *   on Hold Laundry Customer response Updated
*/
async function customerResponseUpdate(req, res) {
    const { bookingId, customerResponse } = req.body

    const bookingFind = await booking.findOne({
        where: {
            id: bookingId
        },
        include: [
            {
                model: addressDb,
                as: 'laundryShop',
                attributes: ['id', 'userId'],
                include: [
                    {
                        model: users,
                        attributes: ['id', 'firstName', 'lastName', 'userTypeId']
                    }
                ]
            }
        ]
    })
    console.log("🚀 ~ customerResponseUpdate ~ bookingFind:", bookingFind.laundryShop.user.id)
    const userId = bookingFind.laundryShop.user.id
    //return res.json(bookingFind)

    await OnHoldConfirmation.update({
        customerResponse: customerResponse,
    }, { where: { bookingId: bookingId } })

    const currentTime = new Date().toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
    const currentDate = new Date().toISOString().split('T')[0];


    await booking.update({
        bookingStatusId: 22
    }, { where: { id: bookingId } })

    await bookingHistory.create({
        bookingId: bookingId,
        bookingStatusId: 22,
        date: currentDate,
        time: currentTime
    })

    let eventData = {
        type: 'customerResponse',
        data: {
            customerResponse: customerResponse,
            bookingId: bookingId
        }
    }

    sendEvent(userId, eventData)
    //two options can send event for new tab or can send notification from here 

    return res.json(responsefunc("1", "Customer Response", {}, ""))

}


/*
  * Customer All bookings
*/
async function allBookings(req, res) {
    const userId = req.user.id

    const findAllBooking = await booking.findAll({
        where: {
            customerId: userId
        },
        include: [
            {
                model: users,
                as: 'customer',
                attributes: ['firstName', 'lastName', 'email']
            },
            {
                model: addressDb,
                as: 'pickupAddress',
                attributes: ['title', 'streetAddress', 'province', 'addressType']
            },
            {
                model: addressDb,
                as: 'dropOffAddress',
                attributes: ['title', 'streetAddress', 'province', 'addressType']
            },
            {
                model: bookingStatus,
                attributes: ['title', 'description']
            }
        ]
    })


    return res.json(responsefunc("1", "Customer All Bookings", findAllBooking, ""))

}

/*
  * Customer booking Detail
*/
async function bookingDetailsById(req, res) {
    const { bookingId, orderTrackId } = req.query

    let whereCondition = {}

    if (bookingId) {
        whereCondition.id = bookingId
    } else {
        whereCondition.orderTrackId = orderTrackId
    }


    const bookingFind = await booking.findOne({
        where: whereCondition,
        include: [
            {
                model: users,
                as: 'customer',
                attributes: ['id', 'firstName', 'lastName', 'email']
            },
            {
                model: addressDb,
                as: 'pickupAddress',
                attributes: ['title', 'streetAddress', 'province', 'district', 'addressType']
            },
            {
                model: addressDb,
                as: 'dropOffAddress',
                attributes: ['title', 'streetAddress', 'province', 'district', 'addressType']
            },
            {
                model: customerSelectedService,
                attributes: ['date', 'time', 'categoryprice', 'categoryId', 'serviceId', 'subCategoryId', 'items']
            },
            {
                model: bookingStatus,
                attributes: ['title', 'description']
            },
            {
                model: bookingHistory,
                attributes: ['date', 'time'],
                include: [
                    {
                        model: bookingStatus,
                        attributes: ['title', 'description']
                    }
                ]
            }

        ]
    })


    return res.json(responsefunc("1", "Customer Order Details Fetched", bookingFind, ""))

}


/*
  * Services For the Customer
*/
async function allServices(req,res) {

    const serviceData=await service.findAll()

    return res.json(responsefunc("1"," All Services",{serviceData},""))
    
}




/*
  *  Specific Service Detail For the Customer
*/
async function serviceDetail(req,res) {
    const{serviceId}=req.params

    const serviceData=await serviceCategories.findAll({
        where:{
            id:serviceId,
            status:true
        },
        include:[
            {
                model:service,
                attributes:['id','name','status']
            },
            {
                model:categories,
                attributes:['id','name','status','image','description'],
                include:[
                    {
                        model:subCategories,
                        attributes:['id','name','status','price']
                    }
                ]
            }
        ]
    })


    return res.json(responsefunc("1","Service Details",{serviceData},""))
    
}
//!---------------------------------Recurring functions------------------------>>>>>
async function addressAdder(addNew, address, type, userId, addressId) {

    console.log("Address Data------>", address.lat);
    console.log("Address Data------>", address.lng);


    if (addNew) {
        const dropOffAddressData = await addressDb.create(address);
        if (address.save) {
            await addressDb.update({
                userId,
                type,
            }, { where: { id: dropOffAddressData.id } });
        }
        return dropOffAddressData.id;
    } else {
        return addressId;
    }
}




let responsefunc = (status, message, data, error) => {
    return {
        status: `${status}`,
        message: `${message}`,
        data: data,
        error: `${error}`

    }
}

async function findZones(lat, lng) {
    // Checking if the coordinates are inside any of the zones
    const findZone = await zone.findAll({
        where: {
            status: true,
            coordinates: sequelize.where(
                sequelize.fn('ST_Contains', sequelize.col('coordinates'), sequelize.fn('ST_GeomFromText', `POINT(${lng} ${lat})`)),
                true
            )
        }
    });

    console.log("🚀 ~ findZones ~ findZone:", findZone);

    if (findZone.length === 0) {
        throw new customError("Service not served in this area");
    }

    return findZone;
}


async function checkIfTimeSlotBooked(shopId, deliveryTimeFrom, deliveryTimeTo, collectionTimeFrom, collectionTimeTo) {
    console.log("🚀 ~ checkIfTimeSlotBooked ~ shopId:", shopId);

    const existingTimeSlots = await booking.findAll({
        where: {
            laundryShopId: shopId,
            [Op.or]: [
                {
                    deliveryDate: fn('DATE', col('deliveryDate')),
                    bookingStatusId: 1,
                    [Op.and]: [
                        { deliveryTimeFrom: { [Op.gte]: deliveryTimeFrom } },
                        { deliveryTimeTo: { [Op.lte]: deliveryTimeTo } }
                    ]
                },
                {
                    collectionDate: fn('DATE', col('collectionDate')),
                    bookingStatusId: 1,
                    [Op.and]: [
                        { collectionTimeFrom: { [Op.gte]: collectionTimeFrom } },
                        { collectionTimeTo: { [Op.lte]: collectionTimeTo } }
                    ]
                }
            ],
        },
        include: [
            {
                model: users,
                as: 'customer',
                attributes: ['id', 'firstName', 'LastName', 'email']
            },
            {
                model: addressDb,
                as: 'laundryShop',
                attributes: [
                    'title', 'customAddresstitle', 'streetAddress', 'district',
                    'province', 'lat', 'lng', 'status', 'addressType', 'coordinates'
                ],
                include: [
                    {
                        model: users,
                        attributes: ['id', 'firstName', 'lastName', 'email', 'phoneNum']
                    },
                    {
                        model: zone,
                        required: true,
                        attributes: ['id', 'name', 'status', 'coordinates']
                    }
                ]
            }
        ]
    });

    console.log("🚀 ~ checkIfTimeSlotBooked ~ existingTimeSlots:", existingTimeSlots);

    return existingTimeSlots;
}




async function bookingEventSentCheckTheShops(bookingId, zoneId, collectionDate, collectionTimeTo, collectionTimeFrom, deliveryDate, deliveryTimeTo, deliveryTimeFrom) {
    let getShopsAndOwners = await addressDb.findAll({
        where: {
            zoneId: zoneId,
            addressType: 'LaundaryShopAddress'
        },
        include: [{
            model: users,
            attributes: ['id', 'firstName', 'email', 'lastName'],
            include: [{
                model: bussinessInformation,
                as: 'businessInfo',
                attributes: ['shopName']
            }]
        }],
        attributes: ['id', 'status', 'zoneId', 'userId']
    });

    console.log("🚀 ~ getBookingDetails ~ getShopsAndOwners ----------------->:", getShopsAndOwners);

    let availableShops = [];

    for (let shop of getShopsAndOwners) {
        let checkSlots = await checkIfTimeSlotBooked(shop.id, deliveryDate, collectionTimeTo, collectionTimeFrom, collectionDate, deliveryTimeTo, deliveryTimeFrom);
        console.log("🚀 ~ getBookingDetails ~ checkSlots:", checkSlots);
        if (!checkSlots || checkSlots.length === 0) {
            availableShops.push(shop);
        }
    }

    console.log("🚀 ~ getBookingDetails ~ availableShops:", availableShops);

    if (availableShops.length > 0) {
        const bookingDetails = await booking.findOne({
            where: { id: bookingId },
            include: [
                {
                    model: users,
                    as: 'customer',
                    attributes: ['firstName', 'lastName', 'email', 'phoneNum']
                },
                {
                    model: billingDetails,
                    attributes: ['total', 'serviceCharge', 'categoryCharge']
                },
                {
                    model: customerSelectedService,
                    include: [{
                        model: service,
                        attributes: ['id', 'name', 'status']
                    },
                    {
                        model: categories,
                        attributes: ['id', 'name', 'status']
                    },
                    {
                        model: subCategories,
                        attributes: ['id', 'name', 'status']
                    }]
                }
            ]
        });

        console.log("🚀 ~ getBookingDetails ~ bookingDetails:", bookingDetails);


        const customerService = bookingDetails.customerSelectedServices.length > 0
            ? bookingDetails.customerSelectedServices.map(serviceItem => ({
                serviceId: serviceItem.service.id,
                serviceName: serviceItem.service.name,
                serviceStatus: serviceItem.service.status,
                categoryId: serviceItem?.category?.id,
                categoryName: serviceItem?.category?.name,
                categoryStatus: serviceItem?.category?.status,
                subCategoryId: serviceItem?.subCategory?.id,
                subCategoryName: serviceItem?.subCategory?.name,
                subCategoryStatus: serviceItem?.subCategory?.status
            }))
            : [];

        const eventData = {
            type: 'newBookingRequest',
            data: availableShops.map(shop => ({
                shopId: shop.id,
                shopName: shop?.user?.businessInfo?.shopName,
                owner: shop.user.firstName + ' ' + shop.user.lastName,
                ownerEmail: shop.user.email,
                zoneId: shop.zoneId,
                bookingId: bookingId,
                customer: {
                    firstName: bookingDetails.customer.firstName,
                    lastName: bookingDetails.customer.lastName,
                    email: bookingDetails.customer.email,
                    phoneNum: bookingDetails.customer.phoneNum
                },
                orderDetails: {
                    orderTrackId: bookingDetails.orderTrackId,
                    collectionDate: collectionDate,
                    collectionTimeTo: collectionTimeTo,
                    collectionTimeFrom: collectionTimeFrom,
                    deliveryDate: deliveryDate,
                    deliveryTimeTo: deliveryTimeTo,
                    deliveryTimeFrom: deliveryTimeFrom,
                    totalAmount: bookingDetails?.billingDetail?.total,
                    serviceCharge: bookingDetails?.billingDetail?.serviceCharge,
                    categoryCharge: bookingDetails?.billingDetail?.categoryCharge,
                    upfrontAmount: bookingDetails?.billingDetail?.upfrontAmount,
                },
                customerServices: {
                    services: customerService
                }
            }))
        };
        availableShops.forEach(shop => {
            sendEvent(shop.user.id, eventData);
        });
    }
}



//!--------------------------------------------------------------------------------------------------------------->>>

module.exports = {
    createBooking,
    onHoldCustomerShow,
    allBookings,
    bookingDetailsById,
    customerResponseUpdate,
    //---------Services----------//
    allServices,
    serviceDetail,
}