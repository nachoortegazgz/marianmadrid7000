type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  traceId?: string;
  data?: any;
}
class Logger {
  private context: Record<string, any> = {};
  setContext(context: Record<string, any>) {
    this.context = { ...this.context, ...context };
  }
  private log(level: LogLevel, message: string, data?: any) {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      traceId: this.context.traceId || crypto.randomUUID(),
      data: { ...this.context, ...data }
    };
    // Sanitizar datos sensibles antes de imprimir
    const sanitizedData = this.sanitize(entry.data);
    console.log(JSON.stringify({ ...entry, data: sanitizedData }));
  }
  private sanitize(data: any): any {
    if (!data) {return data;}
    const sensitive = ['password', 'token', 'secret', 'creditCard'];
    const cloned = JSON.parse(JSON.stringify(data));
    for (const key of Object.keys(cloned)) {
      if (sensitive.some(s => key.toLowerCase().includes(s))) {
        cloned[key] = '***REDACTED***';
      }
    }
    return cloned;
  }
  debug(msg: string, data?: any) { this.log('DEBUG', msg, data); }
  info(msg: string, data?: any) { this.log('INFO', msg, data); }
  warn(msg: string, data?: any) { this.log('WARN', msg, data); }
  error(msg: string, data?: any) { this.log('ERROR', msg, data); }
}
export const logger = new Logger();
