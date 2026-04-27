/* eslint-disable react/no-unknown-property */

function Community() {
  const threads = [
    {
      author: 'Marta Reyes',
      initials: 'MR',
      tag: 'Liderazgo',
      topic: '¿Cómo dais feedback en equipos remotos?',
      body: 'Me cuesta mantener la cercanía cuando el equipo está distribuido en 4 zonas horarias. He probado…',
      replies: 12,
      likes: 28,
      when: 'hace 2h',
    },
    {
      author: 'Diego Lara',
      initials: 'DL',
      tag: 'RGPD',
      topic: 'Plantilla de consentimiento para alumnos menores',
      body: 'Comparto la plantilla que usamos en Acme. Adaptada al artículo 8 del RGPD. Cualquier corrección bienvenida.',
      replies: 4,
      likes: 17,
      when: 'hace 5h',
      solved: true,
    },
    {
      author: 'Carla Núñez',
      initials: 'CN',
      tag: 'IA',
      topic: 'Generador de rúbricas de Didacta — primeras impresiones',
      body: 'He creado 3 rúbricas en una tarde. Sigue habiendo trabajo de revisión, pero el ahorro es real.',
      replies: 21,
      likes: 44,
      when: 'ayer',
    },
  ];

  return (
    <div style={{ padding: '28px 32px 48px', maxWidth: 1200, margin: '0 auto' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          marginBottom: 24,
        }}
      >
        <div>
          <h1
            style={{
              fontFamily: 'Sora',
              fontWeight: 800,
              fontSize: 32,
              color: '#0D1B2A',
              margin: 0,
              letterSpacing: '-0.02em',
            }}
          >
            Comunidad
          </h1>
          <p style={{ fontFamily: 'Inter', fontSize: 15, color: '#475569', marginTop: 6 }}>
            Conversaciones útiles entre formadores, alumnos y administradores.
          </p>
        </div>
        <Button icon="plus" variant="primary">
          Nueva conversación
        </Button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 24 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* filters */}
          <Card style={{ padding: '12px 16px', display: 'flex', gap: 10, alignItems: 'center' }}>
            {['Todo', 'Liderazgo', 'IA', 'RGPD', 'Datos', 'Producto'].map((t, i) => (
              <span
                key={t}
                style={{
                  padding: '6px 12px',
                  borderRadius: 999,
                  fontSize: 13,
                  fontWeight: 500,
                  background: i === 0 ? '#0D1B2A' : '#F1F3F5',
                  color: i === 0 ? '#fff' : '#475569',
                  cursor: 'pointer',
                }}
              >
                {t}
              </span>
            ))}
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 13, color: '#64748B' }}>Ordenar: Más recientes</span>
          </Card>

          {threads.map((t, i) => (
            <Card key={i} hover style={{ padding: 22 }}>
              <div style={{ display: 'flex', gap: 14 }}>
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: '50%',
                    background: 'linear-gradient(135deg,#1E5AA8,#18B5A8)',
                    color: '#fff',
                    display: 'grid',
                    placeItems: 'center',
                    fontFamily: 'Sora',
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  {t.initials}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: '#0D1B2A' }}>
                      {t.author}
                    </span>
                    <Badge tone="info">{t.tag}</Badge>
                    {t.solved ? (
                      <Badge tone="success" dot>
                        Resuelto
                      </Badge>
                    ) : null}
                    <span style={{ fontSize: 12, color: '#94A3B8' }}>{t.when}</span>
                  </div>
                  <div
                    style={{
                      fontFamily: 'Sora',
                      fontWeight: 600,
                      fontSize: 18,
                      color: '#0D1B2A',
                      marginBottom: 6,
                    }}
                  >
                    {t.topic}
                  </div>
                  <div
                    style={{ fontSize: 14, color: '#475569', lineHeight: 1.5, marginBottom: 12 }}
                  >
                    {t.body}
                  </div>
                  <div style={{ display: 'flex', gap: 18, fontSize: 13, color: '#64748B' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Icon name="message" size={14} /> {t.replies} respuestas
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Icon name="trending" size={14} /> {t.likes} útil
                    </span>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card>
            <h4
              style={{
                fontFamily: 'Sora',
                fontWeight: 600,
                fontSize: 16,
                color: '#0D1B2A',
                margin: '0 0 12px',
              }}
            >
              Tu actividad
            </h4>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 13,
                color: '#475569',
                padding: '8px 0',
              }}
            >
              <span>Publicaciones</span>
              <b style={{ color: '#0D1B2A' }}>14</b>
            </div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 13,
                color: '#475569',
                padding: '8px 0',
                borderTop: '1px solid #E2E8F0',
              }}
            >
              <span>Respuestas útiles</span>
              <b style={{ color: '#0F8077' }}>32</b>
            </div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 13,
                color: '#475569',
                padding: '8px 0',
                borderTop: '1px solid #E2E8F0',
              }}
            >
              <span>Reconocimientos</span>
              <b style={{ color: '#1E5AA8' }}>5</b>
            </div>
          </Card>

          <Card>
            <h4
              style={{
                fontFamily: 'Sora',
                fontWeight: 600,
                fontSize: 16,
                color: '#0D1B2A',
                margin: '0 0 12px',
              }}
            >
              Espacios activos
            </h4>
            {[
              { name: 'Formadores', members: 248, color: '#1E5AA8' },
              { name: 'IA en aulas', members: 132, color: '#18B5A8' },
              { name: 'Cumplimiento', members: 87, color: '#FF6F61' },
              { name: 'Producto Didacta', members: 64, color: '#2E7DCE' },
            ].map((s, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '10px 0',
                  borderTop: i ? '1px solid #E2E8F0' : 'none',
                }}
              >
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 8,
                    background: s.color,
                    opacity: 0.15,
                  }}
                />
                <div style={{ flex: 1, fontSize: 14, fontWeight: 500, color: '#0D1B2A' }}>
                  {s.name}
                </div>
                <div style={{ fontSize: 12, color: '#64748B' }}>{s.members}</div>
              </div>
            ))}
          </Card>
        </div>
      </div>
    </div>
  );
}

window.Community = Community;
