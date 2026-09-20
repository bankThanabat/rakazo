<?php
// Synthetic records only. The whole database is destroyed by the driver.
update_option('woocommerce_currency', 'THB');
update_option('woocommerce_default_country', 'TH');
update_option('woocommerce_calc_taxes', 'no');
update_option('woocommerce_bacs_settings', ['enabled' => 'yes', 'title' => 'Fixture bank transfer']);
update_option('woocommerce_enable_guest_checkout', 'yes');
update_option('woocommerce_enable_checkout_login_reminder', 'no');
update_option('woocommerce_enable_signup_and_login_from_checkout', 'no');
update_option('woocommerce_allow_tracking', 'no');
update_option('blog_public', '0');
WC_Install::create_pages();
$product = new WC_Product_Simple();
$product->set_name('Synthetic fixture product');
$product->set_sku('FIXTURE-ONLY');
$product->set_status('publish');
$product->set_regular_price('125.00');
$product->set_virtual(true);
$product->set_manage_stock(true);
$product->set_stock_quantity(10);
$product->save();
$customer = new WC_Customer();
$customer->set_username('fixture-customer');
$customer->set_email('customer@example.test');
$customer->set_password(wp_generate_password(40));
$customer->save();
$physical = new WC_Product_Simple();
$physical->set_name('Synthetic shippable product');
$physical->set_sku('FIXTURE-SHIPPING');
$physical->set_status('publish');
$physical->set_regular_price('49.00');
$physical->set_weight('1');
$physical->save();
$coupon = new WC_Coupon();
$coupon->set_code('fixture-ten');
$coupon->set_discount_type('percent');
$coupon->set_amount(10);
$coupon->save();
$zone = new WC_Shipping_Zone(0);
$instance_id = $zone->add_shipping_method('flat_rate');
update_option('woocommerce_flat_rate_' . $instance_id . '_settings', [
    'enabled' => 'yes', 'title' => 'Fixture shipping', 'cost' => '20.00', 'tax_status' => 'none',
]);
$key = 'ck_' . bin2hex(random_bytes(20));
$secret = 'cs_' . bin2hex(random_bytes(20));
global $wpdb;
$wpdb->insert($wpdb->prefix . 'woocommerce_api_keys', [
    'user_id' => 1,
    'description' => 'Disposable acceptance fixture',
    'permissions' => 'read_write',
    'consumer_key' => wc_api_hash($key),
    'consumer_secret' => $secret,
    'truncated_key' => substr($key, -7),
]);
echo wp_json_encode([
    'productId' => $product->get_id(),
    'physicalProductId' => $physical->get_id(),
    'customerId' => $customer->get_id(),
    'consumerKey' => $key,
    'consumerSecret' => $secret,
    'wordpressVersion' => get_bloginfo('version'),
    'woocommerceVersion' => WC_VERSION,
]);
