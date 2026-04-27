/* eslint-disable react/no-unknown-property */

const headerStyles = {
  root: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    height: 64,
    padding: '0 32px',
    borderBottom: '1px solid #E2E8F0',
    background: '#fff',
    fontFamily: 'Inter, sans-serif',
  },
  search: {
    flex: 1,
    maxWidth: 480,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    background: '#F1F3F5',
    borderRadius: 10,
    padding: '0 14px',
    height: 40,
  },
  searchInput: {
    flex: 1,
    border: 0,
    outline: 0,
    background: 'transparent',
    fontFamily: 'Inter',
    fontSize: 14,
    color: '#0D1B2A',
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    border: '1px solid #E2E8F0',
    background: '#fff',
    display: 'grid',
    placeItems: 'center',
    cursor: 'pointer',
    color: '#475569',
    position: 'relative',
  },
  notif: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 8,
    height: 8,
    borderRadius: 999,
    background: '#FF6F61',
  },
  primary: {
    height: 40,
    padding: '0 16px',
    borderRadius: 10,
    border: 0,
    background: '#1E5AA8',
    color: '#fff',
    fontFamily: 'Inter',
    fontWeight: 600,
    fontSize: 14,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    cursor: 'pointer',
  },
};

function Header({ title }) {
  return (
    <header style={headerStyles.root}>
      <div
        style={{
          fontFamily: 'Sora',
          fontWeight: 700,
          fontSize: 20,
          color: '#0D1B2A',
          marginRight: 8,
        }}
      >
        {title}
      </div>
      <div style={headerStyles.search}>
        <Icon name="search" size={16} stroke="#64748B" />
        <input style={headerStyles.searchInput} placeholder="Busca cursos, rutas o personas…" />
        <span
          style={{
            fontSize: 11,
            color: '#94A3B8',
            border: '1px solid #D7DEE8',
            borderRadius: 6,
            padding: '2px 6px',
          }}
        >
          ⌘K
        </span>
      </div>
      <div style={{ flex: 1 }} />
      <button style={headerStyles.primary}>
        <Icon name="plus" size={16} />
        Crear curso
      </button>
      <div style={headerStyles.iconBtn}>
        <Icon name="message" size={18} />
      </div>
      <div style={headerStyles.iconBtn}>
        <Icon name="bell" size={18} />
        <span style={headerStyles.notif} />
      </div>
    </header>
  );
}

window.Header = Header;
