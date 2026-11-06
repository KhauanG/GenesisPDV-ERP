import { createTheme, type MantineColorsTuple } from '@mantine/core';

/** Azul institucional (sóbrio, bom contraste em tabelas densas) e um cinza-azulado para superfícies. */
const genesis: MantineColorsTuple = [
  '#eef4fb',
  '#dbe6f3',
  '#b3cbe6',
  '#87aed9',
  '#6295ce',
  '#4a85c8',
  '#3c7dc6',
  '#2d6aaf',
  '#245e9d',
  '#1c4d8c',
];

const ardosia: MantineColorsTuple = [
  '#f2f5f8',
  '#e4e8ed',
  '#c5ced9',
  '#a3b2c3',
  '#8699b0',
  '#7389a4',
  '#68819f',
  '#576e8b',
  '#4b627d',
  '#3c5470',
];

export const tema = createTheme({
  primaryColor: 'genesis',
  primaryShade: { light: 8, dark: 5 },
  colors: { genesis, ardosia },
  fontFamily:
    'Inter, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif',
  headings: { fontWeight: '650' },
  defaultRadius: 'sm',
  cursorType: 'pointer',
  components: {
    Table: { defaultProps: { verticalSpacing: 'xs', highlightOnHover: true } },
    TextInput: { defaultProps: { size: 'sm' } },
    Button: { defaultProps: { size: 'sm' } },
    Paper: { defaultProps: { withBorder: true, radius: 'md' } },
  },
});
