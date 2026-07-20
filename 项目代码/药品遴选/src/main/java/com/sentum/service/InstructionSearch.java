package com.sentum.service;

import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import org.springframework.stereotype.Service;


public interface InstructionSearch {
    JSONObject getInstruction(String str);
}
