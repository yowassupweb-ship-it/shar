/**
 * Знак ШАР — атом (/logo-shar-120.png, уменьшенная копия logo-shar.png).
 * Статичный: состояние связи показывает подпись рядом, а не вращение знака.
 */
export default function SharMark({ size = 24 }: { size?: number; busy?: boolean }) {
  return (
    <span className="nx-mark" style={{ width: size, height: size }} aria-hidden="true">
      <img src="/logo-shar-120.png" alt="" width={size} height={size} draggable={false} />
    </span>
  );
}
