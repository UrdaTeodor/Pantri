// Preact + htm, re-exported so every UI module imports from one place.
import { h, Fragment, createContext, render } from 'preact';
import {
  useState, useEffect, useMemo, useRef, useCallback, useContext, useReducer, useLayoutEffect,
} from 'preact/hooks';
import htm from 'htm';

export const html = htm.bind(h);
export {
  h, Fragment, createContext, render,
  useState, useEffect, useMemo, useRef, useCallback, useContext, useReducer, useLayoutEffect,
};
