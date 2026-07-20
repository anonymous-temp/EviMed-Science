package com.sentum.pojo.dto;

import com.alibaba.fastjson.JSONObject;
import com.sentum.pojo.vo.GuidelinesVo;
import lombok.Data;

@Data
public class GuideDto {

    private GuidelinesVo   guidelines;

   private JSONObject guide;

}
