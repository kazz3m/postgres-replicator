export function Spinner({ size = 4 }: { size?: number }) {
  return (
    <div
      className={`w-${size} h-${size} border-2 border-gray-600 border-t-blue-400 rounded-full animate-spin inline-block`}
    />
  )
}
