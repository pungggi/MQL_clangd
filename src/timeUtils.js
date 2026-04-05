'use strict';

/**
 * Format date component with leading zero
 * @param {Date} date - Date object
 * @param {string} t - Component type (Y, M, D, h, m, s)
 * @param {any} [d] - Default/intermediate value
 * @returns {string} Formatted string
 */
function tf(date, t, d) {
    switch (t) {
        case 'Y': d = date.getFullYear(); break;
        case 'M': d = date.getMonth() + 1; break;
        case 'D': d = date.getDate(); break;
        case 'h': d = date.getHours(); break;
        case 'm': d = date.getMinutes(); break;
        case 's': d = date.getSeconds(); break;
    }
    return d < 10 ? '0' + d.toString() : d.toString();
}

module.exports = { tf };
