const express=require('express')
const router =express()
const asyncMiddleware=require('../middlewares/asyncHandler')
const multer=require('multer')
const path=require('path')
const validateAccessToken=require('../middlewares/accessToken')
const driverController=require('../controllers/Driver/driverAuth')


//!----------------------Multer Middlewares------------------//

//for uploading driver profile Images
const uploadProfileImages=multer.diskStorage({
    destination:(req,file,cb)=>{
        cb(null,'./Public/DriverProfileImages')
    },
    filename:(req,file,cb)=>{
        cb(null,'Driver-Profile' + Date.now() + path.extname(file.originalname))
    }
})

const uploadProfile=multer({
    storage:uploadProfileImages
});


//For uploading driver Liecense
const uploadLicImgs = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, `./Public/LicenseImages`)
    },
    filename: (req, file, cb) => {
        cb(null, 'LicImg-' + req.body.userId + '-'+  Date.now() +  path.extname(file.originalname))
    }
})
const uploadLic = multer({
    storage: uploadLicImgs,
});

//For uploading vehicle Images
const uploadVehImgs=multer.diskStorage({
    destination:(req,file,cb)=>{
        cb(null,'./Public/VehicleImages')
    },
    filename:(req,file,cb)=>{
        cb(null,"VehImg-"+ req.body.userId + "--" + Date.now() + path.extname(file.originalname))
    }
})

const uploadVeh= multer({
    storage:uploadVehImgs
})

//Driver Registration 1st Step
router.post('/driverRegisterStep1',uploadProfile.fields([{name:'profileImage',maxCount:1}]),asyncMiddleware(driverController.driverregisterStep1))
//Driver Registration 2nd Step
router.post('/driverRegisterStep2', uploadVeh.array('vehImages', 10), asyncMiddleware(driverController.driverRegisterStep2))
//Verify OTP
router.post('/verifyotp',asyncMiddleware(driverController.verifyOTP))
//Upload Driver Vehicle Images
router.post('/uploadVehImages', validateAccessToken, uploadVeh.array('vehImages', 10), asyncMiddleware(driverController.uploadVehicleImages))
//Driver registration Step 3
router.post('/driverRegisterStep3',uploadLic.fields([{name: 'frontImage', maxCount: 1}, {name: 'backImage', maxCount: 1} ]) , asyncMiddleware(driverController.driverRegister3))
//Resend OTP
router.post('/resendotp',asyncMiddleware(driverController.resendOTP))
//upload Vehicle Images
router.post('/uploadVehImages', validateAccessToken, uploadVeh.array('vehImages', 10), asyncMiddleware(driverController.uploadVehicleImages))
//Get All vehicle Types
router.get('/allvehicletypes', asyncMiddleware(driverController.getActiveVehicleTypes));
//Upload License Images
router.post('/uploadLicenseImages', validateAccessToken, uploadLic.fields([{name: 'frontImage', maxCount: 1}, {name: 'backImage', maxCount: 1} ]) , asyncMiddleware(driverController.uploadLicenseImages))
//Login Driver
router.post('/driverLogin', asyncMiddleware(driverController.driverLogin))
//Forget Password Request
router.post('/forgetpasswordrequest', asyncMiddleware(driverController.forgetPasswordRequest));
//Verify Otp for Password
router.post('/verifyotpforpass', asyncMiddleware(driverController.verifyOTPforPassword));
//Change Password
router.post('/changepasswordotp', asyncMiddleware(driverController.changePasswordOTP));
//Session API
router.post('/session',validateAccessToken,asyncMiddleware(driverController.session))



















module.exports=router