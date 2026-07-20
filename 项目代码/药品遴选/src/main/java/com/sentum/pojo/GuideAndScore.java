package com.sentum.pojo;


import com.sentum.pojo.vo.GuideVO;
import lombok.Data;

import java.util.ArrayList;
import java.util.List;

@Data
public class GuideAndScore {

    private String score;

    private List<GuideVO> guideVOS;

    public GuideAndScore() {
        this.score = "0";
        this.guideVOS = new ArrayList<GuideVO>() ;
    }


}
