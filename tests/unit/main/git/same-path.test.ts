import { describe, expect, it } from 'vitest';
import { samePath } from '../../../../src/main/git/git-service';

describe('samePath (008 R2, Windows paths)', () => {
  it('Given git printing C:/… and a native C:\\… path, When compared on win32, Then they are the same folder', () => {
    expect(
      samePath(
        'C:/Users/runneradmin/AppData/Local/Temp/w',
        'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\w',
        'win32',
      ),
    ).toBe(true);
  });

  it('Given two drive letters that differ only by case, When compared on win32, Then they are the same folder', () => {
    expect(samePath('c:/Users/x/dev', 'C:\\Users\\x\\dev', 'win32')).toBe(true);
  });

  it('Given a trailing separator and a redundant segment, When compared on win32, Then they are the same folder', () => {
    expect(samePath('C:/Users/x/./dev/', 'C:\\Users\\x\\dev', 'win32')).toBe(true);
  });

  it('Given two different folders or drives, When compared on win32, Then they differ', () => {
    expect(samePath('C:/Users/x/dev', 'C:\\Users\\x\\dev-2', 'win32')).toBe(false);
    expect(samePath('C:/Users/x/dev', 'D:\\Users\\x\\dev', 'win32')).toBe(false);
    expect(samePath('C:/Users/x/dev', 'C:\\Users\\x\\dev\\sub', 'win32')).toBe(false);
  });

  it('Given paths that differ by case on POSIX, When compared, Then they differ (case-sensitive there)', () => {
    expect(samePath('/tmp/Dev', '/tmp/dev', 'linux')).toBe(false);
    expect(samePath('/tmp/dev/', '/tmp/dev', 'linux')).toBe(true);
  });
});
