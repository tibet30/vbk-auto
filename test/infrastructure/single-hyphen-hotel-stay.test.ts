import test from 'node:test';
import assert from 'node:assert/strict';
import {hotelStayRequirement} from '../../src/shared/hotel-stay-requirement.js';
test('single-hyphen lodging routes repair only the old full-route anchor',()=>{
 const route='火车站接-帕拉庄园【配讲解】-江孜宗山古堡【配讲解】-白居寺-住日喀则';
 const product={basicInfo:{userIdea:`日喀则2日游\n4钻酒店\nD1、${route}`}};
 const day={day:1,hotelRequirement:{anchorName:route,cityName:'日喀则'}};
 assert.equal(hotelStayRequirement(product,day)?.anchorName,'日喀则');
 assert.equal(hotelStayRequirement(product,{...day,hotelRequirement:{anchorName:'日喀则市人民政府',cityName:'日喀则'}})?.anchorName,'日喀则市人民政府');
});
