import { beforeEach, describe, expect, it } from 'vitest'
import { isNavLinkClick, loadMainCollapsed, mainFloor, saveMainCollapsed } from './mainCollapse'

beforeEach(() => {
  localStorage.clear()
})

describe('loadMainCollapsed / saveMainCollapsed', () => {
  it('is expanded on a first visit', () => {
    expect(loadMainCollapsed()).toBe(false)
  })

  it('round-trips both states', () => {
    saveMainCollapsed(true)
    expect(loadMainCollapsed()).toBe(true)
    saveMainCollapsed(false)
    expect(loadMainCollapsed()).toBe(false)
    expect(localStorage.getItem('mesa-main-collapsed')).toBeNull()
  })

  it('reads anything but "1" as expanded', () => {
    for (const raw of ['true', '0', '', 'null']) {
      localStorage.setItem('mesa-main-collapsed', raw)
      expect(loadMainCollapsed()).toBe(false)
    }
  })
})

describe('mainFloor', () => {
  it('is the floor while expanded and zero while folded', () => {
    expect(mainFloor(false, 320)).toBe(320)
    expect(mainFloor(true, 320)).toBe(0)
  })
})

describe('isNavLinkClick', () => {
  it('matches a link inside the nav only', () => {
    document.body.innerHTML =
      '<nav class="sidebar"><a id="a"><span id="s"></span></a><button id="b"></button></nav><a id="o"></a>'
    expect(isNavLinkClick(document.getElementById('s'))).toBe(true)
    expect(isNavLinkClick(document.getElementById('b'))).toBe(false)
    expect(isNavLinkClick(document.getElementById('o'))).toBe(false)
    expect(isNavLinkClick(null)).toBe(false)
  })
})
