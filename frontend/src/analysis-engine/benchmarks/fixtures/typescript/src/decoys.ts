/*
import { commentOnly } from './missing-comment-module.js';
*/
const message = `
import { templateOnly } from './missing-template-module.js';
`;
export function useMessage() {
  return message.length;
}
