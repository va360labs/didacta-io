/* eslint-disable react/no-unknown-property */

const COURSES = [
  {
    id: 1,
    title: 'Liderazgo transformador',
    cat: 'Habilidades',
    level: 'Intermedio',
    modules: 12,
    hours: 6,
    progress: 68,
    tag: 'En curso',
    tone: 'info',
    cover: 'linear-gradient(135deg,#0D1B2A,#1E5AA8)',
  },
  {
    id: 2,
    title: 'Comunicación efectiva',
    cat: 'Habilidades',
    level: 'Inicial',
    modules: 8,
    hours: 4,
    progress: 100,
    tag: 'Completado',
    tone: 'success',
    cover: 'linear-gradient(135deg,#18B5A8,#2E7DCE)',
  },
  {
    id: 3,
    title: 'RGPD para formadores',
    cat: 'Cumplimiento',
    level: 'Obligatorio',
    modules: 6,
    hours: 3,
    progress: 12,
    tag: 'Pendiente',
    tone: 'warn',
    cover: 'linear-gradient(135deg,#1E5AA8,#2E7DCE)',
  },
  {
    id: 4,
    title: 'Analítica de aprendizaje',
    cat: 'Datos',
    level: 'Avanzado',
    modules: 10,
    hours: 8,
    progress: 32,
    tag: 'En curso',
    tone: 'info',
    cover: 'linear-gradient(135deg,#2E7DCE,#18B5A8)',
  },
];

function CourseCard({ course, onOpen }) {
  return (
    <Card style={{ padding: 0, overflow: 'hidden' }} hover onClick={() => onOpen?.(course)}>
      <div
        style={{
          height: 110,
          background: course.cover,
          position: 'relative',
          display: 'flex',
          alignItems: 'flex-end',
          padding: 14,
        }}
      >
        <Badge
          tone={course.tone}
          dot
          style={{
            background: 'rgba(255,255,255,.92)',
            color:
              course.tone === 'success'
                ? '#0F8077'
                : course.tone === 'warn'
                  ? '#C8473A'
                  : '#1E5AA8',
          }}
        >
          {course.tag}
        </Badge>
        {/* book motif */}
        <svg
          style={{ position: 'absolute', right: -10, bottom: -10, opacity: 0.18 }}
          width="120"
          height="80"
          viewBox="0 0 120 80"
          fill="none"
          stroke="#fff"
          strokeWidth="2"
        >
          <path d="M10 60 Q60 30 110 60 L110 70 Q60 40 10 70 Z" />
          <path d="M10 50 Q60 20 110 50" />
        </svg>
      </div>
      <div style={{ padding: '18px 22px 22px' }}>
        <div style={{ fontSize: 12, color: '#64748B', fontWeight: 500, marginBottom: 6 }}>
          {course.cat} · {course.level}
        </div>
        <div
          style={{
            fontFamily: 'Sora',
            fontWeight: 700,
            fontSize: 18,
            color: '#0D1B2A',
            lineHeight: 1.25,
            marginBottom: 10,
          }}
        >
          {course.title}
        </div>
        <div style={{ fontSize: 13, color: '#475569', marginBottom: 14 }}>
          {course.modules} módulos · {course.hours}h
        </div>
        <Progress
          value={course.progress}
          tone={course.tone === 'warn' ? 'warn' : course.tone === 'success' ? 'success' : 'info'}
        />
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: 12,
          }}
        >
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: course.tone === 'success' ? '#0F8077' : '#1F2A3A',
            }}
          >
            {course.progress}% completado
          </span>
          <Button
            variant={course.progress === 100 ? 'secondary' : 'primary'}
            size="sm"
            icon={course.progress === 100 ? 'award' : 'arrow-r'}
          >
            {course.progress === 100 ? 'Certificado' : 'Continuar'}
          </Button>
        </div>
      </div>
    </Card>
  );
}

window.COURSES = COURSES;
window.CourseCard = CourseCard;
