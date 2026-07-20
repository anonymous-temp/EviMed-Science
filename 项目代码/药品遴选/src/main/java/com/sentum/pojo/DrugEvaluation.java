package com.sentum.pojo;



import java.util.List;

public class DrugEvaluation {
    private Object _id;
    private String listId;
    private List<ListInfo> listInfo;

    public Object get_id() { return _id; }
    public void set_id(Object _id) { this._id = _id; }
    public String getListId() { return listId; }
    public void setListId(String listId) { this.listId = listId; }
    public List<ListInfo> getListInfo() { return listInfo; }
    public void setListInfo(List<ListInfo> listInfo) { this.listInfo = listInfo; }
}
