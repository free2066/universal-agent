/**
 * v0.4.0 — Multimodal content type tests
 * Tests: getContentText, ImageBlock, ImageUrlBlock, ContentBlock type guards
 */
import { describe, it, expect } from 'vitest';
import {
  getContentText,
  type ImageBlock,
  type ImageUrlBlock,
  type ContentBlock,
} from '../../src/models/types.js';

describe('getContentText', () => {
  it('returns string as-is', () => {
    expect(getContentText('hello world')).toBe('hello world');
  });

  it('returns empty string for empty string', () => {
    expect(getContentText('')).toBe('');
  });

  it('extracts plain text from ContentBlock[] with only string elements', () => {
    const blocks: ContentBlock[] = ['hello', ' ', 'world'];
    expect(getContentText(blocks)).toBe('hello world');
  });

  it('replaces ImageBlock with [image] placeholder', () => {
    const blocks: ContentBlock[] = [
      'look at this: ',
      { type: 'image', data: 'abc123', mimeType: 'image/png' } as ImageBlock,
    ];
    expect(getContentText(blocks)).toBe('look at this: [image]');
  });

  it('replaces ImageUrlBlock with [image: <url>] placeholder', () => {
    const blocks: ContentBlock[] = [
      { type: 'image_url', url: 'https://example.com/img.png' } as ImageUrlBlock,
      ' — see above',
    ];
    expect(getContentText(blocks)).toBe('[image: https://example.com/img.png] — see above');
  });

  it('handles mixed blocks (text + image + image_url)', () => {
    const blocks: ContentBlock[] = [
      'prefix ',
      { type: 'image', data: 'base64data', mimeType: 'image/jpeg' } as ImageBlock,
      ' middle ',
      { type: 'image_url', url: 'https://cdn.example.com/photo.jpg' } as ImageUrlBlock,
      ' suffix',
    ];
    const result = getContentText(blocks);
    expect(result).toBe('prefix [image] middle [image: https://cdn.example.com/photo.jpg] suffix');
  });

  it('handles empty ContentBlock array', () => {
    expect(getContentText([])).toBe('');
  });

  it('handles array with only an ImageBlock', () => {
    const blocks: ContentBlock[] = [
      { type: 'image', data: 'data', mimeType: 'image/png' } as ImageBlock,
    ];
    expect(getContentText(blocks)).toBe('[image]');
  });

  it('does not include base64 data in output', () => {
    const longBase64 = 'A'.repeat(10000);
    const blocks: ContentBlock[] = [
      { type: 'image', data: longBase64, mimeType: 'image/png' } as ImageBlock,
    ];
    const result = getContentText(blocks);
    expect(result).toBe('[image]');
    expect(result).not.toContain(longBase64);
  });
});

describe('ImageBlock type shape', () => {
  it('ImageBlock has correct fields', () => {
    const block: ImageBlock = {
      type: 'image',
      data: 'iVBORw0KGgo=',
      mimeType: 'image/png',
    };
    expect(block.type).toBe('image');
    expect(block.data).toBe('iVBORw0KGgo=');
    expect(block.mimeType).toBe('image/png');
  });

  it('ImageUrlBlock has correct fields', () => {
    const block: ImageUrlBlock = {
      type: 'image_url',
      url: 'data:image/png;base64,abc',
    };
    expect(block.type).toBe('image_url');
    expect(block.url).toBe('data:image/png;base64,abc');
  });
});

describe('getContentText — edge cases', () => {
  it('handles multiline string content', () => {
    expect(getContentText('line1\nline2\nline3')).toBe('line1\nline2\nline3');
  });

  it('handles unicode in text blocks', () => {
    const blocks: ContentBlock[] = ['你好 🌍 ', { type: 'image', data: 'x', mimeType: 'image/png' } as ImageBlock];
    expect(getContentText(blocks)).toBe('你好 🌍 [image]');
  });

  it('string block inside array preserves whitespace', () => {
    const blocks: ContentBlock[] = ['  spaces  '];
    expect(getContentText(blocks)).toBe('  spaces  ');
  });
});
