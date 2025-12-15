const fs = require('fs');

const createDestinationDirectory = (destinationPath, cb) => {
  fs.access(destinationPath, (error) => {
    if (error) {
      // Directory does not exist, create it
      fs.mkdir(destinationPath, { recursive: true }, (err) => {
        if (err) {
          console.error('Error creating destination directory:', err);
          cb(err, null);
        } else {
          cb(null, destinationPath);
        }
      });
    } else {
      // Directory already exists
      cb(null, destinationPath);
    }
  });
};

module.exports = {
  createDestinationDirectory,
};