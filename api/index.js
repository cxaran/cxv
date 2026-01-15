const addonInterface = require('../server')

module.exports = (req, res) => {
    if (!req.url) {
        req.url = '/'
    }
    return addonInterface(req, res)
}
