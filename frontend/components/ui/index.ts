/**
 * Barrel for the reusable primitives. Import from '@/components/ui' so a
 * component can be moved or split without touching every call site.
 */

export { Button } from './button';
export type { ButtonProps, ButtonSize, ButtonVariant } from './button';

export { Input, Select, Textarea } from './input';
export type { InputProps, SelectProps, TextareaProps } from './input';

export { DataTable, TBody, THead, Table, Td, Th, Tr } from './table';
export type { Column, DataTableProps } from './table';

export { Modal, ModalFooter } from './modal';
export type { ModalProps } from './modal';
