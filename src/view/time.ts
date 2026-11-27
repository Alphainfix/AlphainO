/** Dates the way AlphainZ shows them in its chat history, in the interface language. */
import { isChinese, t } from '../i18n';

/** "3 minutes ago" / "3 分钟前". */
export function timeAgo(iso: string, now = Date.now()): string {
    const time = Date.parse(iso);
    if (Number.isNaN(time)) return '';
    const seconds = Math.round((time - now) / 1000);
    const format = new Intl.RelativeTimeFormat(isChinese() ? 'zh-CN' : 'en', { numeric: 'auto' });
    const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [
        ['year', 365 * 24 * 3600],
        ['month', 30 * 24 * 3600],
        ['week', 7 * 24 * 3600],
        ['day', 24 * 3600],
        ['hour', 3600],
        ['minute', 60],
    ];
    for (const [unit, size] of steps) if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
    return format.format(0, 'second');
}

function startOfDay(date: Date): number {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * The history group a date falls in, as AlphainZ names them (English keys,
 * shown through `t`): Today, Yesterday, This Week (from Monday), This Month,
 * Older.
 */
export function dateGroup(iso: string, now = new Date()): 'Today' | 'Yesterday' | 'This Week' | 'This Month' | 'Older' {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return 'Older';
    const day = startOfDay(date);
    const today = startOfDay(now);
    if (day === today) return 'Today';
    if (day === today - 24 * 3600 * 1000) return 'Yesterday';
    const weekStart = today - ((now.getDay() + 6) % 7) * 24 * 3600 * 1000;
    if (day >= weekStart && day <= today) return 'This Week';
    if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) return 'This Month';
    return 'Older';
}

/** A compact age for the chats under the empty view, as AlphainZ's RecentChats: "now", "3m", "2h", "1d", "2w", "3mo". */
export function compactTime(iso: string, now = Date.now()): string {
    const time = Date.parse(iso);
    if (Number.isNaN(time)) return '';
    const diffMs = now - time;
    const minutes = Math.floor(diffMs / 60_000);
    const hours = Math.floor(diffMs / 3_600_000);
    const days = Math.floor(diffMs / 86_400_000);
    const weeks = Math.floor(days / 7);
    if (minutes < 1) return t('now');
    if (minutes < 60) return t('{count}m', { count: minutes });
    if (hours < 24) return t('{count}h', { count: hours });
    if (days < 7) return t('{count}d', { count: days });
    if (weeks < 5) return t('{count}w', { count: weeks });
    return t('{count}mo', { count: Math.floor(days / 30) });
}
