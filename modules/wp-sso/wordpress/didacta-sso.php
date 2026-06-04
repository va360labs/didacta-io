<?php
/**
 * Plugin Name: Didacta SSO
 * Description: Single Sign-On desde WordPress hacia Didacta. Para el usuario YA logueado en WordPress, firma un token corto (HMAC) y lo lleva a Didacta autenticado. Companion de mod.wp-sso.
 * Version: 0.1.0
 * Author: VA360 LABS
 *
 * INSTALACIÓN
 *  1. Copia este archivo a wp-content/plugins/didacta-sso/didacta-sso.php y actívalo.
 *  2. En wp-config.php define (mismos valores que en Didacta):
 *       define('DIDACTA_SSO_SECRET', 'el-secreto-compartido-largo-y-aleatorio');
 *       define('DIDACTA_SSO_CALLBACK', 'https://dev.didacta.io/api/v1/modules/wp-sso/callback');
 *     Opcionales:
 *       define('DIDACTA_SSO_AUDIENCE', 'didacta-wp-sso'); // default
 *       define('DIDACTA_SSO_TTL', 120);                    // segundos, default 120
 *  3. Enlaza a Didacta con cualquiera de estas opciones:
 *       - Botón/shortcode:  [didacta_sso_button label="Ir a Didacta"]
 *       - URL directa:       https://tu-wordpress/?didacta_sso=go
 *     Si el usuario no está logueado en WP, se le manda a wp-login y vuelve.
 *
 * SEGURIDAD
 *  - El token es HS256, vive DIDACTA_SSO_TTL segundos (≤ 300 que exige Didacta)
 *    y es de un solo uso (jti). NO incluyas datos sensibles: solo email + nombre.
 *  - El secreto NUNCA viaja al navegador; solo firma server-side en WordPress.
 */

if (!defined('ABSPATH')) {
    exit; // No acceso directo.
}

if (!defined('DIDACTA_SSO_AUDIENCE')) {
    define('DIDACTA_SSO_AUDIENCE', 'didacta-wp-sso');
}
if (!defined('DIDACTA_SSO_TTL')) {
    define('DIDACTA_SSO_TTL', 120);
}

/** base64url sin padding. */
function didacta_sso_b64url($data) {
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

/** Firma un JWT HS256 con los claims del usuario logueado. Devuelve el compact JWT. */
function didacta_sso_build_token($user) {
    $secret = defined('DIDACTA_SSO_SECRET') ? DIDACTA_SSO_SECRET : '';
    if (empty($secret)) {
        return null;
    }
    $now = time();
    $header = array('alg' => 'HS256', 'typ' => 'JWT');
    $payload = array(
        'iss'   => rtrim(home_url(), '/'),
        'aud'   => DIDACTA_SSO_AUDIENCE,
        'email' => strtolower(trim($user->user_email)),
        'name'  => trim($user->display_name),
        'iat'   => $now,
        'exp'   => $now + (int) DIDACTA_SSO_TTL,
        // jti único: garantiza single-use en Didacta (anti-replay).
        'jti'   => function_exists('wp_generate_uuid4') ? wp_generate_uuid4() : bin2hex(random_bytes(16)),
    );
    $segments = array(
        didacta_sso_b64url(wp_json_encode($header)),
        didacta_sso_b64url(wp_json_encode($payload)),
    );
    $signing_input = implode('.', $segments);
    $signature = hash_hmac('sha256', $signing_input, $secret, true);
    $segments[] = didacta_sso_b64url($signature);
    return implode('.', $segments);
}

/** URL absoluta al callback de Didacta con el token firmado. */
function didacta_sso_callback_url($user) {
    $callback = defined('DIDACTA_SSO_CALLBACK') ? DIDACTA_SSO_CALLBACK : '';
    if (empty($callback)) {
        return null;
    }
    $token = didacta_sso_build_token($user);
    if (empty($token)) {
        return null;
    }
    return add_query_arg('token', rawurlencode($token), $callback);
}

/**
 * Handler de `/?didacta_sso=go`. Si el usuario está logueado, firma y redirige a
 * Didacta; si no, lo manda a wp-login y vuelve a esta misma URL tras loguearse.
 */
function didacta_sso_handle_go() {
    if (!isset($_GET['didacta_sso']) || $_GET['didacta_sso'] !== 'go') {
        return;
    }
    if (!is_user_logged_in()) {
        $self = home_url(add_query_arg(array('didacta_sso' => 'go')));
        wp_safe_redirect(wp_login_url($self));
        exit;
    }
    $url = didacta_sso_callback_url(wp_get_current_user());
    if (empty($url)) {
        wp_die('Didacta SSO no está configurado (falta DIDACTA_SSO_SECRET o DIDACTA_SSO_CALLBACK en wp-config.php).');
    }
    wp_redirect($url); // 302 al callback de Didacta — NO usar wp_safe_redirect (host externo).
    exit;
}
add_action('template_redirect', 'didacta_sso_handle_go');

/** Shortcode [didacta_sso_button label="Ir a Didacta"]. */
function didacta_sso_button_shortcode($atts) {
    $atts = shortcode_atts(array('label' => 'Ir a Didacta'), $atts, 'didacta_sso_button');
    $go = esc_url(home_url(add_query_arg(array('didacta_sso' => 'go'), '/')));
    return sprintf(
        '<a class="didacta-sso-button button" href="%s">%s</a>',
        $go,
        esc_html($atts['label'])
    );
}
add_shortcode('didacta_sso_button', 'didacta_sso_button_shortcode');
