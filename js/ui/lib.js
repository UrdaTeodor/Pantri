// Preact + htm, re-exported so every UI module imports from one place.
import { h, Fragment, createContext, render, Component } from 'preact';
import {
  useState, useEffect, useMemo, useRef, useCallback, useContext, useReducer, useLayoutEffect,
} from 'preact/hooks';
import htm from 'htm';

export const html = htm.bind(h);
/** Callback ref that focuses an element once it is mounted (autofocus doesn't fire for inserted nodes). */
export const focusOnMount = el => {
  if (el && !el.dataset.focused) {
    el.dataset.focused = '1';
    setTimeout(() => el.focus(), 60);
  }
};

export {
  h, Fragment, createContext, render, Component,
  useState, useEffect, useMemo, useRef, useCallback, useContext, useReducer, useLayoutEffect,
};
