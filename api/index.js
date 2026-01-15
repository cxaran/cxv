const addonInterface = require('../server')
const getRouter = require('stremio-addon-sdk/src/getRouter')

const router = getRouter(addonInterface)

module.exports = (req, res) => {
    if (!req.url) {
        req.url = '/'
    }

    if (req.url === '/') {
        res.statusCode = 302
        res.setHeader('Location', '/manifest.json')
        res.end()
        return
    }

    router(req, res, (err) => {
        if (err) {
            console.error(err)
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ err: 'handler error' }))
            return
        }

        res.statusCode = 404
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ err: 'not found' }))
    })
}
