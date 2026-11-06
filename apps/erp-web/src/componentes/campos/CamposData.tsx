/**
 * Campos de data no formato pt-BR (ERP 6, 1.5): os `<input type="datetime-local|month|date">` nativos seguem o
 * idioma do navegador/SO ("mm/dd/yyyy", "October 2026"). Estes usam o `@mantine/dates` com o `DatesProvider` pt-br
 * (App.tsx) e mantêm o valor no formato dos formulários: `AAAA-MM-DDTHH:mm` (data e hora local), `AAAA-MM-DD` (data)
 * e `AAAA-MM` (mês).
 */
import {
  DatePickerInput,
  DateTimePicker,
  MonthPickerInput,
  type DatePickerInputProps,
  type DateTimePickerProps,
} from '@mantine/dates';

/** `AAAA-MM-DDTHH:mm` ↔ `AAAA-MM-DD HH:mm:ss` do Mantine. */
const paraPicker = (v: string) => (v ? `${v.replace('T', ' ').slice(0, 16)}:00` : null);
const doPicker = (v: string | null) => (v ? v.replace(' ', 'T').slice(0, 16) : '');

export function CampoDataHora({
  value,
  onChange,
  ...props
}: Omit<DateTimePickerProps, 'value' | 'onChange' | 'defaultValue'> & {
  value?: string;
  onChange?: (valor: string) => void;
}) {
  return (
    <DateTimePicker
      valueFormat="DD/MM/YYYY HH:mm"
      clearable
      {...props}
      value={paraPicker(value ?? '')}
      onChange={(v) => onChange?.(doPicker(v))}
    />
  );
}

/** Mês/ano: `AAAA-MM` ↔ primeiro dia do mês; exibido como "Outubro/2026". */
export function CampoMes({
  value,
  onChange,
  label,
  w,
}: {
  value: string;
  onChange: (mes: string) => void;
  label: string;
  w?: number;
}) {
  return (
    <MonthPickerInput
      label={label}
      w={w}
      valueFormat="MMMM/YYYY"
      value={value ? `${value}-01` : null}
      onChange={(v) => onChange(v ? v.slice(0, 7) : '')}
      styles={{ input: { textTransform: 'capitalize' } }}
    />
  );
}

/** Data sem hora: `AAAA-MM-DD` (o valor do Mantine), exibida como `dd/mm/aaaa`. */
export function CampoData({
  value,
  onChange,
  ...props
}: Omit<DatePickerInputProps, 'value' | 'onChange' | 'defaultValue' | 'type'> & {
  value?: string;
  onChange?: (valor: string) => void;
}) {
  return (
    <DatePickerInput
      valueFormat="DD/MM/YYYY"
      clearable
      {...props}
      value={value ? value.slice(0, 10) : null}
      onChange={(v) => onChange?.(v ? String(v).slice(0, 10) : '')}
    />
  );
}
