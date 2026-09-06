export function isConstructor(obj: any): boolean {
    return typeof obj === 'function' && 'prototype' in obj;
}

export function getConstructorName(obj: any): string {
    return Object.getPrototypeOf(obj).constructor.name
}

export function convertToMap(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  
  const map = new Map();
  for (const key in obj) {
    map.set(key, obj[key]);
  }
  return map;
}

export function replacer(key, value) {
  if(value instanceof Map) {
    return {
      dataType: 'Map',
      value: Array.from(value.entries()), // or with spread: value: [...value]
    };
  } else {
    return value;
  }
}

export function reviver(key, value) {
  if(typeof value === 'object' && value !== null) {
    if (value.dataType === 'Map') {
      return new Map(value.value);
    }
  }
  return value;
}