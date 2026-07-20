package com.sentum.pojo.vo;


import lombok.Data;

import java.util.List;

@Data
public class TrGuideVo {

    private Double score;

    private List<GuideVO> guideVOList;

}
