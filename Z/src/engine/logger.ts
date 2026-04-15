/**
 * src/engine/logger.ts
 * 核心诊断日志拦截追踪系统 (Diagnostic Logger System)
 */

interface LogEntry {
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  category: 'system' | 'ffmpeg' | 'webcodecs' | 'ui';
  message: string;
  data?: any;
}

class LoggerTrackingSystem {
  private logs: LogEntry[] = [];
  private readonly MAX_LOGS = 5000;

  constructor() {
    this.hijackConsole();
  }

  private addLog(entry: Omit<LogEntry, 'timestamp'>) {
    this.logs.push({ ...entry, timestamp: Date.now() });
    if (this.logs.length > this.MAX_LOGS) {
      this.logs.shift();
    }
  }

  public info(category: LogEntry['category'], message: string, data?: any) {
    this.addLog({ level: 'info', category, message, data });
  }

  public warn(category: LogEntry['category'], message: string, data?: any) {
    this.addLog({ level: 'warn', category, message, data });
  }

  public error(category: LogEntry['category'], message: string, data?: any) {
    this.addLog({ level: 'error', category, message, data });
  }

  private hijackConsole() {
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;

    console.log = (...args: any[]) => {
      const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
      const category = msg.includes('[FFmpeg]') ? 'ffmpeg' : msg.includes('[WebCodecs]') ? 'webcodecs' : 'system';
      this.info(category, msg);
      origLog.apply(console, args);
    };

    console.warn = (...args: any[]) => {
      const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
      const category = msg.includes('[FFmpeg]') ? 'ffmpeg' : msg.includes('[WebCodecs]') ? 'webcodecs' : 'system';
      this.warn(category, msg);
      origWarn.apply(console, args);
    };

    console.error = (...args: any[]) => {
      const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
      const category = msg.includes('[FFmpeg]') ? 'ffmpeg' : msg.includes('[WebCodecs]') ? 'webcodecs' : 'system';
      this.error(category, msg);
      origError.apply(console, args);
    };
  }

  public getLogs() {
    return [...this.logs];
  }

  public exportLogs() {
    const logContent = this.logs.map(l => {
      const time = new Date(l.timestamp).toISOString();
      const levelStr = l.level.toUpperCase().padEnd(5, ' ');
      const catStr = l.category.toUpperCase().padEnd(10, ' ');
      return `[${time}] [${levelStr}] [${catStr}] ${l.message} ${l.data ? JSON.stringify(l.data) : ''}`;
    }).join('\n');

    const blob = new Blob([logContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `titan_diagnostic_${new Date().getTime()}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }
}

export const logger = new LoggerTrackingSystem();
