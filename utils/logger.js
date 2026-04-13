const fs = require('fs');
const path = require('path');

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Log file paths
const logFile = path.join(logsDir, 'app.log');
const errorLogFile = path.join(logsDir, 'error.log');

// Format timestamp
function getTimestamp() {
    return new Date().toISOString();
}

// Write to file and console
function log(level, message, data = null) {
    const timestamp = getTimestamp();
    const logEntry = {
        timestamp,
        level,
        message,
        ...(data && { data })
    };
    
    const logString = JSON.stringify(logEntry, null, 2) + '\n';
    
    // Write to console
    console.log(logString);
    
    // Write to file
    try {
        fs.appendFileSync(logFile, logString);
        
        if (level === 'ERROR') {
            fs.appendFileSync(errorLogFile, logString);
        }
    } catch (err) {
        console.error('Failed to write to log file:', err);
    }
}

module.exports = {
    info: (message, data) => log('INFO', message, data),
    error: (message, data) => log('ERROR', message, data),
    warn: (message, data) => log('WARN', message, data),
    debug: (message, data) => log('DEBUG', message, data),
    request: (method, path, origin, body) => {
        log('REQUEST', `${method} ${path}`, { origin, body });
    }
};
