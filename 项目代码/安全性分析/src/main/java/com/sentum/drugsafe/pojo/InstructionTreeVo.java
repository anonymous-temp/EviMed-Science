package com.sentum.drugsafe.pojo;


import lombok.Data;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;

@Data
public class InstructionTreeVo<T> {

    private String fatherTitle;

    private List<T> children;

    public InstructionTreeVo(){
        this.children = new ArrayList<T>();
    }

    public InstructionTreeVo(String nmpa, ArrayList<T> nmpaMap) {
        this.fatherTitle = nmpa;
        this.children = nmpaMap;
    }
}
