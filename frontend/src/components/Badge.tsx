import clsx from 'clsx'

interface Props { label: string; variant?: 'green' | 'red' | 'yellow' | 'blue' | 'gray' }

export function Badge({ label, variant = 'gray' }: Props) {
  return (
    <span className={clsx('px-2 py-0.5 rounded text-xs font-semibold whitespace-nowrap', {
      'bg-green-900 text-green-300': variant === 'green',
      'bg-red-900 text-red-300': variant === 'red',
      'bg-yellow-900 text-yellow-300': variant === 'yellow',
      'bg-blue-900 text-blue-300': variant === 'blue',
      'bg-gray-800 text-gray-300': variant === 'gray',
    })}>
      {label}
    </span>
  )
}
