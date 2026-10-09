
function requireAdmin(req, res, next) {
    if (req.session && req.session.user && req.session.user.role === 'admin') {
        return next();
    }

    return res.redirect('/admin/login');
}

function requireCustomer(req, res, next) {
    if (req.session && req.session.user && req.session.user.role === 'customer') {
        return next();
    }

    return res.redirect('/login');
}

module.exports = {
    requireAdmin,
    requireCustomer
};