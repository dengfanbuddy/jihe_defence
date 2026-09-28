/**
 * 导表校验报告：收集所有错误/警告，最后统一输出。
 * 默认「有错误即失败」，`--strict` 时警告也升级为失败。
 */
export class Report {
    errors: string[] = [];
    warnings: string[] = [];

    error(msg: string): void {
        this.errors.push(msg);
    }

    warn(msg: string): void {
        this.warnings.push(msg);
    }

    get ok(): boolean {
        return this.errors.length === 0;
    }

    /** 是否通过（strict 模式下警告也算失败） */
    pass(strict: boolean): boolean {
        return strict ? this.errors.length === 0 && this.warnings.length === 0 : this.ok;
    }

    merge(other: Report): void {
        this.errors.push(...other.errors);
        this.warnings.push(...other.warnings);
    }

    reset(): void {
        this.errors = [];
        this.warnings = [];
    }
}
