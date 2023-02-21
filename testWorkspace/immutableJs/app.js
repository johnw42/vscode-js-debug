const { Map: IMap } = require('immutable');

class EntryView {
  constructor(entry) {
    this.key = entry[0];
    this.value = entry[1];
  }

  toString() {
    return `${this.key} => ${this.value}`;
  }
}

IMap.prototype.__msft_debugView = function () {
  // throw Error("xyzzy");
  // const self = this;
  // return {
  //   size: this.size,
  //   entries: this.entrySeq()
  //     .toArray()
  //     .map(entry => ({ key: entry[0], value: entry[1] })),
  //   toString() {
  //     return self.toString();
  //   },
  // };
  const entryArray = this.entrySeq().toArray();
  return new Proxy(this, {
    ownKeys(target) {
      const keys = ['size'];
      for (let i = 0; i < entryArray.length; i++) {
        keys.push(String(i));
      }
      return keys;
    },
    get(target, prop, receiver) {
      switch (prop) {
        case 'size':
          return target.size;
        case 'length':
          return undefined;
        default:
          if (prop in entryArray) {
            return new EntryView(entryArray[prop]);
          }
      }
    },
  });
};

const main = () => {
  // const plainObject = { a: 1, b: 2 };
  // const proxy = new Proxy({}, {});
  // const realMap = new Map([
  //   ['a', 1],
  //   ['b', 2],
  // ]);
  const immutableMap = IMap({ a: 1, b: 2 });
  const view = new EntryView(["dummyKey", "dummyValue"]);
  const wrapper = { view, immutableMap };
  // const immutableMapView = immutableMap.__msft_debugView();
  // console.log(immutableMap.get('a'));
  // console.log('hello');
  while (true) {
    debugger;
  }
};

main();
