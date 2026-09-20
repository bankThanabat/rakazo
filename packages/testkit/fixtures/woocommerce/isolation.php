<?php
// This fixture has no external egress, mail, cron or payment gateway.
// Simulate TLS termination for Basic authentication over owned loopback HTTP.
$_SERVER['HTTPS'] = 'on';
add_filter('pre_wp_mail', '__return_true');
add_filter('pre_http_request', function () {
    return new WP_Error('fixture_egress_disabled', 'External requests are disabled in this fixture.');
});
