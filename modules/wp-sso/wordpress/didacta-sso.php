<?php
/**
 * Plugin Name: Didacta SSO
 * Description: Single Sign-On desde WordPress hacia Didacta. Para el usuario YA logueado en WordPress, firma un token corto (HMAC) y lo lleva a Didacta autenticado. Companion de mod.wp-sso.
 * Version: 0.2.0
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
 *       - URL directa (explícita):    https://tu-wordpress/?didacta_sso=go
 *       - URL transparente (silenciosa, la usa el auto-bounce de Didacta):
 *                                     https://tu-wordpress/?didacta_sso=try
 *     `go`: si no hay sesión WP, manda a wp-login y vuelve.
 *     `try`: si no hay sesión WP, vuelve EN SILENCIO a la signin de Didacta
 *            (?wp_sso=login_required), SIN mostrar wp-login.
 *
 * IDENTIDAD (v0.2.0)
 *  - El token incluye `sub` = WordPress user_id (identidad ESTABLE; Didacta vincula
 *    por `sub`, no por email, para resistir cambios/reuso de email).
 *  - `email_verified` se firma como FALSE por defecto. WordPress core no mantiene un
 *    estado fiable de verificación de email: NO lo pongas a true a ciegas. Para
 *    derivarlo de una fuente real (p.ej. double-opt-in de FluentCRM) usa el filtro:
 *       add_filter('didacta_sso_email_verified', function ($v, $user) { return ...; }, 10, 2);
 *
 * SEGURIDAD
 *  - El token es HS256, vive DIDACTA_SSO_TTL segundos (≤ 300 que exige Didacta)
 *    y es de un solo uso (jti). NO incluyas datos sensibles: solo email + nombre + sub.
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
        // sub = identidad ESTABLE del usuario en WordPress (Didacta vincula por aquí).
        'sub'   => (string) $user->ID,
        'email' => strtolower(trim($user->user_email)),
        'name'  => trim($user->display_name),
        // email_verified: false por defecto. Wírealo a una fuente real (FluentCRM
        // double-opt-in, etc.) con el filtro 'didacta_sso_email_verified'. NUNCA true a ciegas.
        'email_verified' => (bool) apply_filters('didacta_sso_email_verified', false, $user),
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

/** Origen (scheme://host[:port]) de Didacta, derivado de DIDACTA_SSO_CALLBACK. */
function didacta_sso_didacta_origin() {
    $callback = defined('DIDACTA_SSO_CALLBACK') ? DIDACTA_SSO_CALLBACK : '';
    if (empty($callback)) {
        return null;
    }
    $parts = wp_parse_url($callback);
    if (empty($parts['scheme']) || empty($parts['host'])) {
        return null;
    }
    $origin = $parts['scheme'] . '://' . $parts['host'];
    if (!empty($parts['port'])) {
        $origin .= ':' . $parts['port'];
    }
    return $origin;
}

/**
 * Handler de `/?didacta_sso=go|try`.
 *   - go:  flujo EXPLÍCITO (botón). Sin sesión WP → wp-login y vuelve.
 *   - try: flujo TRANSPARENTE (auto-bounce desde la signin de Didacta). Sin sesión
 *          WP → vuelve EN SILENCIO a la signin de Didacta con `?wp_sso=login_required`
 *          (NUNCA muestra wp-login). Con sesión WP, igual que go.
 */
function didacta_sso_handle_request() {
    $mode = isset($_GET['didacta_sso']) ? sanitize_key($_GET['didacta_sso']) : '';
    if ($mode !== 'go' && $mode !== 'try') {
        return;
    }

    if (!is_user_logged_in()) {
        if ($mode === 'try') {
            // Fallo silencioso: de vuelta a Didacta sin pasar por wp-login.
            $origin = didacta_sso_didacta_origin();
            if (!empty($origin)) {
                wp_redirect($origin . '/signin?wp_sso=login_required');
                exit;
            }
        }
        // go (o try sin origen configurable): comportamiento clásico.
        $self = home_url(add_query_arg(array('didacta_sso' => $mode)));
        wp_safe_redirect(wp_login_url($self));
        exit;
    }

    $url = didacta_sso_callback_url(wp_get_current_user());
    if (empty($url)) {
        if ($mode === 'try') {
            $origin = didacta_sso_didacta_origin();
            if (!empty($origin)) {
                wp_redirect($origin . '/signin?wp_sso=sso_unavailable');
                exit;
            }
        }
        wp_die('Didacta SSO no está configurado (falta DIDACTA_SSO_SECRET o DIDACTA_SSO_CALLBACK en wp-config.php).');
    }
    wp_redirect($url); // 302 al callback de Didacta — NO usar wp_safe_redirect (host externo).
    exit;
}
add_action('template_redirect', 'didacta_sso_handle_request');

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
