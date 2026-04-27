/* eslint-disable react/no-unknown-property */

const sidebarStyles = {
  root: {
    width: 240,
    minHeight: '100vh',
    background: '#0D1B2A',
    color: '#fff',
    fontFamily: 'Inter, system-ui, sans-serif',
    display: 'flex',
    flexDirection: 'column',
    padding: '20px 16px',
    boxSizing: 'border-box',
    flexShrink: 0,
  },
  brand: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '4px 8px 24px',
    borderBottom: '1px solid rgba(255,255,255,0.08)',
    marginBottom: 16,
  },
  brandText: {
    fontFamily: 'Sora, sans-serif',
    fontWeight: 700,
    fontSize: 22,
    letterSpacing: '-0.01em',
    color: '#fff',
  },
  group: {
    fontSize: 11,
    fontWeight: 500,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'rgba(255,255,255,0.4)',
    padding: '14px 10px 8px',
  },
  item: (active) => ({
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 12px',
    borderRadius: 10,
    fontSize: 14,
    fontWeight: active ? 600 : 500,
    color: active ? '#fff' : 'rgba(255,255,255,0.72)',
    background: active ? 'rgba(46, 125, 206, 0.18)' : 'transparent',
    cursor: 'pointer',
    marginBottom: 2,
    border: active ? '1px solid rgba(46, 125, 206, 0.32)' : '1px solid transparent',
    transition: 'background .15s ease',
  }),
  spacer: { flex: 1 },
  user: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 8px',
    borderTop: '1px solid rgba(255,255,255,0.08)',
    marginTop: 12,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: '50%',
    background: 'linear-gradient(135deg, #2E7DCE, #18B5A8)',
    display: 'grid',
    placeItems: 'center',
    color: '#fff',
    fontWeight: 700,
    fontSize: 13,
    fontFamily: 'Sora',
  },
  userName: { fontSize: 13, fontWeight: 600, color: '#fff' },
  userRole: { fontSize: 12, color: 'rgba(255,255,255,0.5)' },
};

function SidebarItem({ icon, label, active, badge, onClick }) {
  return (
    <div style={sidebarStyles.item(active)} onClick={onClick}>
      <Icon name={icon} size={18} />
      <span style={{ flex: 1 }}>{label}</span>
      {badge ? (
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            padding: '2px 8px',
            borderRadius: 999,
            background: '#FF6F61',
            color: '#fff',
          }}
        >
          {badge}
        </span>
      ) : null}
    </div>
  );
}

function Sidebar({ active, onNavigate }) {
  const items = [
    { id: 'home', icon: 'home', label: 'Inicio' },
    { id: 'courses', icon: 'book', label: 'Cursos' },
    { id: 'routes', icon: 'route', label: 'Rutas' },
    { id: 'community', icon: 'users', label: 'Comunidad', badge: 3 },
    { id: 'calendar', icon: 'calendar', label: 'Calendario' },
    { id: 'reports', icon: 'chart', label: 'Informes' },
    { id: 'certificates', icon: 'award', label: 'Certificados' },
  ];
  const admin = [
    { id: 'compliance', icon: 'shield', label: 'Cumplimiento' },
    { id: 'settings', icon: 'settings', label: 'Ajustes' },
  ];

  return (
    <aside style={sidebarStyles.root}>
      <div style={sidebarStyles.brand}>
        <img
          src="../../assets/anagrama.png"
          alt=""
          style={{ width: 36, height: 36, borderRadius: 8 }}
        />
        <span style={sidebarStyles.brandText}>Didacta</span>
      </div>

      <div style={sidebarStyles.group}>Aprendizaje</div>
      {items.map((it) => (
        <SidebarItem
          key={it.id}
          {...it}
          active={active === it.id}
          onClick={() => onNavigate?.(it.id)}
        />
      ))}

      <div style={sidebarStyles.group}>Administración</div>
      {admin.map((it) => (
        <SidebarItem
          key={it.id}
          {...it}
          active={active === it.id}
          onClick={() => onNavigate?.(it.id)}
        />
      ))}

      <div style={sidebarStyles.spacer} />

      <div style={sidebarStyles.user}>
        <div style={sidebarStyles.avatar}>AC</div>
        <div style={{ flex: 1 }}>
          <div style={sidebarStyles.userName}>Ana Carrillo</div>
          <div style={sidebarStyles.userRole}>Formadora · ACME</div>
        </div>
        <Icon name="logout" size={16} stroke="rgba(255,255,255,0.5)" />
      </div>
    </aside>
  );
}

window.Sidebar = Sidebar;
