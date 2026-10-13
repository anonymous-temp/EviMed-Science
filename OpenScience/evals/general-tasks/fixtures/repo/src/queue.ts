export class Queue<T> {
  private items: T[] = [];
  push(item: T): void { this.items.push(item); }
  shift(): T | undefined { return this.items.shift(); }
  get size(): number { return this.items.length; }
}
