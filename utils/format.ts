/** 字节数的人类可读格式（ TasksPanel 状态行与 popup 页签行总速度共用） */
export const bytes = (value: number): string => {
  if (!value || value < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
};
