package com.sentum.drugsafe.service;

import com.alibaba.fastjson.JSONObject;
import com.sentum.drugsafe.pojo.InstructionTreeVo;
import com.sentum.drugsafe.pojo.Vo.InstructionVo;
import com.sentum.drugsafe.pojo.Vo.PageVo;


import java.util.List;

public interface InstructionService {

     List<JSONObject>   getInstructionTree(String id);


    PageVo<InstructionVo> navigationList(String id, String oneLevelTerm, String twoLevelTerm, String threeLevelTerm, Integer pageSize, Integer pageNum, String search);
}
