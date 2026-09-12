import { app } from 'electron';
import fs from 'fs';
import path from 'path';

let dataDir: string | null = null;

function getDataDir(): string {
  if (!dataDir) {
    dataDir = path.join(app.getPath('userData'), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }
  return dataDir;
}

export function readJSON<T>(filename: string, defaultValue: T): T {
  const filePath = path.join(getDataDir(), filename);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch {}
  return defaultValue;
}

export function writeJSON(filename: string, data: any): void {
  const filePath = path.join(getDataDir(), filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function deleteJSON(filename: string): boolean {
  const filePath = path.join(getDataDir(), filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}
