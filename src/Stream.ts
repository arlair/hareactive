/** @module hareactive/stream */

import {
  MapFunction,
  SubscribeFunction,
  ScanFunction,
  FilterFunction,
  Consumer
} from "./frp-common";

import {Behavior, at, scan, fromFunction} from "./Behavior";

class NoopConsumer implements Consumer<any> {
  push(): void {};
}

const noopConsumer = new NoopConsumer();

/**
 * A stream is a list of occurences over time. Each occurence happens
 * at a discrete point in time and has an associated value.
 * Semantically it is a list `type Stream<A> = [Time, A]`.
 */
export abstract class Stream<A> implements Consumer<any> {
  child: Consumer<A>;
  nrOfListeners: number;

  constructor() {
    this.child = noopConsumer;
    this.nrOfListeners = 0;
  }

  subscribe(fn: SubscribeFunction<A>): Consumer<A> {
    const listener = {push: fn};
    this.addListener(listener);
    return listener;
  }

  abstract push(a: any, changed?: any): void;

  map<B>(fn: MapFunction<A, B>): Stream<B> {
    const s = new MapStream(fn);
    this.addListener(s);
    return s;
  }

  mapTo<B>(val: B): Stream<B> {
    const s = new MapToStream(val);
    this.addListener(s);
    return s;
  }

  merge<B>(otherStream: Stream<B>): Stream<(A|B)> {
    const s = new SinkStream<(A|B)>();
    this.addListener(s);
    otherStream.addListener(s);
    return s;
  }

  filter(fn: FilterFunction<A>): Stream<A> {
    const s = new FilterStream<A>(fn);
    this.addListener(s);
    return s;
  }

  scanS<B>(fn: ScanFunction<A, B>, startingValue: B): Behavior<Stream<B>> {
    return fromFunction(() => new ScanStream(fn, startingValue, this));
  }

  scan<B>(fn: ScanFunction<A, B>, init: B): Behavior<Behavior<B>> {
    return scan(fn, init, this);
  }

  addListener(c: Consumer<A>): void {
    const nr = ++this.nrOfListeners;
    if (nr === 1) {
      this.child = c;
    } else if (nr === 2) {
      this.child = new MultiConsumer(this.child, c);
    } else {
      (<MultiConsumer<A>>this.child).listeners.push(c);
    }
  }

  removeListener(listener: Consumer<any>): void {
    const nr = --this.nrOfListeners;
    if (nr === 0) {
      this.child = noopConsumer;
    } else if (nr === 1) {
      const l = (<MultiConsumer<A>>this.child).listeners;
      this.child = l[l[0] === listener ? 1 : 0];
    } else {
      const l = (<MultiConsumer<A>>this.child).listeners;
      const idx = l.indexOf(listener);
      if (idx !== -1) {
        if (idx !== l.length - 1) {
          l[idx] = l[l.length - 1];
        }
        l.length--; // remove the last element of the list
      }
    }
  }
}

/** @private */
export class SinkStream<A> extends Stream<A> {
  push(a: A): void {
    this.child.push(a);
  }
}

class MapStream<A, B> extends Stream<B> {
  constructor(private fn: MapFunction<A, B>) {
    super();
  }
  push(a: A): void {
    this.child.push(this.fn(a));
  }
}

class MapToStream<A> extends Stream<A> {
  constructor(private val: A) { super(); }
  push(a: any): void {
    this.child.push(this.val);
  }
}

class FilterStream<A> extends Stream<A> {
  constructor(private fn: FilterFunction<A>) {
    super();
  }
  push(a: A): void {
    if (this.fn(a) === true) {
      this.child.push(a);
    }
  }
}

/**
 * @param fn A predicate function that returns a boolean for `A`.
 * @param stream The stream to filter.
 * @returns Stream that only contains the occurences from `stream`
 * for which `fn` returns true.
 */
export function filter<A>(fn: (a: A) => boolean, stream: Stream<A>): Stream<A> {
  return stream.filter(fn);
}

class ScanStream<A, B> extends Stream<B> {
  constructor(private fn: ScanFunction<A, B>, private last: B, source: Stream<A>) {
    super();
    source.addListener(this);
  }
  push(a: A): void {
    const val = this.last = this.fn(a, this.last);
    this.child.push(val);
  }
}

/**
 * The returned  initially has the initial value, on each
 * occurence in `source` the function is applied to the current value
 * of the behaviour and the value of the occurence, the returned value
 * becomes the next value of the behavior.
 */
export function scanS<A, B>(fn: ScanFunction<A, B>, startingValue: B, stream: Stream<A>): Behavior<Stream<B>> {
  return fromFunction(() => new ScanStream(fn, startingValue, stream));
}

class SnapshotStream<A, B> extends Stream<[A, B]> {
  constructor(private behavior: Behavior<B>, stream: Stream<A>) {
    super();
    stream.addListener(this);
  }
  push(a: A): void {
    this.child.push([a, at(this.behavior)]);
  }
}

export function snapshot<A, B>(behavior: Behavior<B>, stream: Stream<A>): Stream<[A, B]> {
  return new SnapshotStream(behavior, stream);
}

class SnapshotWithStream<A, B, C> extends Stream<C> {
  constructor(
    private fn: (a: A, b: B) => C,
    private behavior: Behavior<B>,
    stream: Stream<A>
  ) {
    super();
    stream.child = this;
    // stream.eventListeners.push(this);
  }
  push(a: A): void {
    this.child.push(this.fn(a, at(this.behavior)));
  }
}

class MultiConsumer<A> implements Consumer<A> {
  listeners: Consumer<A>[];
  constructor(c1: Consumer<A>, c2: Consumer<A>) {
    this.listeners = [c1, c2];
  }
  push(a: A): void {
    for (let i = 0; i < this.listeners.length; ++i) {
      this.listeners[i].push(a);
    }
  }
}

export function snapshotWith<A, B, C>(
  fn: (a: A, b: B) => C,
  behavior: Behavior<B>,
  stream: Stream<A>
): Stream<C> {
  return new SnapshotWithStream(fn, behavior, stream);
}

class SwitchBehaviorStream<A> extends Stream<A> {
  private currentSource: Stream<A>;
  constructor(private b: Behavior<Stream<A>>) {
    super();
    b.addListener(this);
    const cur = this.currentSource = at(b);
    cur.addListener(this);
  }
  push(a: any, changer: any): void {
    if (changer === this.b) {
      this.doSwitch(a);
    } else {
      this.child.push(a);
    }
  }
  private doSwitch(newStream: Stream<A>): void {
    this.currentSource.removeListener(this);
    newStream.addListener(this);
    this.currentSource = newStream;
  }
}

/**
 * Takes a stream valued behavior and returns at stream that emits
 * values from the current stream at the behavior.
 */
export function switchStream<A>(b: Behavior<Stream<A>>): Stream<A> {
  return new SwitchBehaviorStream(b);
}

export function mergeList<A>(ss: Stream<A>[]): Stream<A> {
  return ss.reduce((s1, s2) => s1.merge(s2), empty());
}

/**
 * @returns A stream that never has any occurrences.
 */
export function empty<A>(): Stream<A> {
  return new SinkStream<A>();
}

export function subscribe<A>(fn: SubscribeFunction<A>, stream: Stream<A>): void {
  stream.subscribe(fn);
}

export function publish<A>(a: A, stream: Stream<A>): void {
  stream.push(a);
}

export function merge<A, B>(a: Stream<A>, b: Stream<B>): Stream<(A|B)> {
  return a.merge(b);
}

export function map<A, B>(fn: MapFunction<A, B> , stream: Stream<A>): Stream<B> {
  return stream.map(fn);
}

export function isStream(obj: any): boolean {
  return (obj instanceof Stream);
}
