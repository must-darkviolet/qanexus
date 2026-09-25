import { useInView } from '../hooks.js';

// Fades and lifts its content in once it scrolls into view. `delay` staggers siblings.
export default function Reveal({ as: Tag = 'div', delay = 0, className = '', style, children, ...rest }) {
  const [ref, shown] = useInView();
  return (
    <Tag
      ref={ref}
      className={`reveal ${className}`.trim()}
      data-shown={shown}
      style={{ '--reveal-delay': `${delay}ms`, ...style }}
      {...rest}
    >
      {children}
    </Tag>
  );
}
